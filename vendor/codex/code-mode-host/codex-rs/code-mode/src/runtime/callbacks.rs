use codex_code_mode_protocol::FunctionCallOutputContentItem;

use super::EXIT_SENTINEL;
use super::RuntimeEvent;
use super::RuntimeState;
use super::json_size;
use super::timers;
use super::value::json_to_v8;
use super::value::normalize_output_audio;
use super::value::normalize_output_image;
use super::value::serialize_output_text;
use super::value::throw_type_error;
use super::value::v8_value_to_json;

fn emit_output(
    scope: &mut v8::PinScope<'_, '_>,
    item: FunctionCallOutputContentItem,
) -> Result<(), String> {
    emit_outputs(scope, vec![item])
}

fn emit_outputs(
    scope: &mut v8::PinScope<'_, '_>,
    items: Vec<FunctionCallOutputContentItem>,
) -> Result<(), String> {
    let bytes = items
        .iter()
        .map(output_item_bytes)
        .fold(0, usize::saturating_add);
    let state = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?;
    let observed = state.output_bytes.saturating_add(bytes);
    if let Some(limits) = state.limits
        && observed > limits.output_bytes.get() as usize
    {
        return Err(format!(
            "resource limit exceeded: code=resource_exhausted resource=output_bytes limit={} observed={observed}",
            limits.output_bytes
        ));
    }
    state.output_bytes = observed;
    for item in items {
        state
            .event_tx
            .send(RuntimeEvent::ContentItem(item))
            .map_err(|_| "runtime output channel closed".to_string())?;
    }
    Ok(())
}

fn output_item_bytes(item: &FunctionCallOutputContentItem) -> usize {
    match item {
        FunctionCallOutputContentItem::InputText { text } => text.len(),
        FunctionCallOutputContentItem::InputImage { image_url, detail } => {
            image_url.len()
                + detail.map_or(0, |detail| match detail {
                    crate::ImageDetail::Auto => 4,
                    crate::ImageDetail::Low => 3,
                    crate::ImageDetail::High => 4,
                    crate::ImageDetail::Original => 8,
                })
        }
        FunctionCallOutputContentItem::InputAudio { audio_url } => audio_url.len(),
    }
}

pub(super) fn tool_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let tool_index = match args.data().to_rust_string_lossy(scope).parse::<usize>() {
        Ok(tool_index) => tool_index,
        Err(_) => {
            throw_type_error(scope, "invalid tool callback data");
            return;
        }
    };
    let input = if args.length() == 0 {
        Ok(None)
    } else {
        v8_value_to_json(scope, args.get(0))
    };
    let input = match input {
        Ok(input) => input,
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };

    if let Err(error_text) = admit_delegate(scope) {
        throw_type_error(scope, &error_text);
        return;
    }

    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        throw_type_error(scope, "failed to create tool promise");
        return;
    };
    let promise = resolver.get_promise(scope);

    let resolver = v8::Global::new(scope, resolver);
    let (tool_name, tool_kind) = {
        let Some(state) = scope.get_slot::<RuntimeState>() else {
            throw_type_error(scope, "runtime state unavailable");
            return;
        };
        let Some(tool) = state.enabled_tools.get(tool_index) else {
            throw_type_error(scope, "tool callback data is out of range");
            return;
        };
        (tool.tool_name.clone(), tool.kind)
    };

    let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    let id = format!("tool-{}", state.next_tool_call_id);
    state.next_tool_call_id = state.next_tool_call_id.saturating_add(1);
    let event_tx = state.event_tx.clone();
    state.pending_tool_calls.insert(id.clone(), resolver);
    let _ = event_tx.send(RuntimeEvent::ToolCall {
        id,
        name: tool_name,
        kind: tool_kind,
        input,
    });
    retval.set(promise.into());
}

pub(super) fn text_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) => text,
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };
    if let Err(error_text) = emit_output(scope, FunctionCallOutputContentItem::InputText { text }) {
        throw_type_error(scope, &error_text);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn audio_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let audio_item = match normalize_output_audio(scope, value) {
        Ok(audio_item) => audio_item,
        Err(()) => return,
    };
    if let Err(error_text) = emit_output(scope, audio_item) {
        throw_type_error(scope, &error_text);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let detail_override = if args.length() < 2 {
        None
    } else {
        let detail = args.get(1);
        if detail.is_string() {
            Some(detail.to_rust_string_lossy(scope))
        } else if detail.is_null() || detail.is_undefined() {
            None
        } else {
            throw_type_error(scope, "image detail must be a string when provided");
            return;
        }
    };
    let image_item = match normalize_output_image(scope, value, detail_override) {
        Ok(image_item) => image_item,
        Err(()) => return,
    };
    if let Err(error_text) = emit_output(scope, image_item) {
        throw_type_error(scope, &error_text);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn generated_image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let output_hint = match generated_image_output_hint(scope, value) {
        Ok(output_hint) => output_hint,
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };
    let image_item = match normalize_output_image(scope, value, /*detail_override*/ None) {
        Ok(image_item) => image_item,
        Err(()) => return,
    };
    let mut items = vec![image_item];
    if let Some(text) = output_hint {
        items.push(FunctionCallOutputContentItem::InputText { text });
    }
    if let Err(error_text) = emit_outputs(scope, items) {
        throw_type_error(scope, &error_text);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

fn generated_image_output_hint(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<String>, String> {
    let object = v8::Local::<v8::Object>::try_from(value)
        .map_err(|_| "generatedImage expects an image generation result object".to_string())?;
    let key = v8::String::new(scope, "output_hint")
        .ok_or_else(|| "failed to allocate generatedImage helper keys".to_string())?;
    let output_hint = object
        .get(scope, key.into())
        .ok_or_else(|| "failed to read generatedImage output_hint".to_string())?;
    if output_hint.is_undefined() {
        return Ok(None);
    }
    if !output_hint.is_string() {
        return Err("generatedImage output_hint must be a string when provided".to_string());
    }
    Ok(Some(output_hint.to_rust_string_lossy(scope)))
}

pub(super) fn store_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    let key = match args.get(0).to_string(scope) {
        Some(key) => key.to_rust_string_lossy(scope),
        None => {
            throw_type_error(scope, "store key must be a string");
            return;
        }
    };
    let value = args.get(1);
    let serialized = match v8_value_to_json(scope, value) {
        Ok(Some(value)) => value,
        Ok(None) => {
            throw_type_error(
                scope,
                &format!("Unable to store {key:?}. Only plain serializable objects can be stored."),
            );
            return;
        }
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };
    if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        let new_size = key.len().saturating_add(json_size(&serialized));
        let old_size = state.stored_value_sizes.get(&key).copied().unwrap_or(0);
        let observed = state
            .stored_values_bytes
            .saturating_sub(old_size)
            .saturating_add(new_size);
        if let Some(limit) = state.max_committed_state_bytes
            && observed > limit
        {
            throw_type_error(
                scope,
                &format!(
                    "resource limit exceeded: code=resource_exhausted resource=committed_state_bytes limit={limit} observed={observed}"
                ),
            );
            return;
        }
        state.stored_values_bytes = observed;
        state.stored_value_sizes.insert(key.clone(), new_size);
        state.stored_values.insert(key.clone(), serialized.clone());
        state.stored_value_writes.insert(key, serialized);
    }
}

pub(super) fn load_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let key = match args.get(0).to_string(scope) {
        Some(key) => key.to_rust_string_lossy(scope),
        None => {
            throw_type_error(scope, "load key must be a string");
            return;
        }
    };
    let value = scope
        .get_slot::<RuntimeState>()
        .and_then(|state| state.stored_values.get(&key))
        .cloned();
    let Some(value) = value else {
        retval.set(v8::undefined(scope).into());
        return;
    };
    let Some(value) = json_to_v8(scope, &value) else {
        throw_type_error(scope, "failed to load stored value");
        return;
    };
    retval.set(value);
}

pub(super) fn notify_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) => text,
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };
    if text.trim().is_empty() {
        throw_type_error(scope, "notify expects non-empty text");
        return;
    }
    if let Err(error_text) = admit_delegate(scope) {
        throw_type_error(scope, &error_text);
        return;
    }
    if let Some(state) = scope.get_slot::<RuntimeState>() {
        let _ = state.event_tx.send(RuntimeEvent::Notify {
            call_id: state.tool_call_id.clone(),
            text,
        });
    }
    retval.set(v8::undefined(scope).into());
}

fn admit_delegate(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
    let state = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?;
    let observed = state.pending_delegate_calls.saturating_add(1);
    if let Some(limit) = state.max_pending_delegate_calls
        && observed > limit
    {
        return Err(format!(
            "resource limit exceeded: code=resource_exhausted resource=delegate_calls limit={limit} observed={observed}"
        ));
    }
    state.pending_delegate_calls = observed;
    Ok(())
}

pub(super) fn set_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let timeout_id = match timers::schedule_timeout(scope, args) {
        Ok(timeout_id) => timeout_id,
        Err(error_text) => {
            throw_type_error(scope, &error_text);
            return;
        }
    };

    retval.set(v8::Number::new(scope, timeout_id as f64).into());
}

pub(super) fn clear_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    if let Err(error_text) = timers::clear_timeout(scope, args) {
        throw_type_error(scope, &error_text);
        return;
    }

    retval.set(v8::undefined(scope).into());
}

pub(super) fn yield_control_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    if let Some(state) = scope.get_slot::<RuntimeState>() {
        let _ = state.event_tx.send(RuntimeEvent::YieldRequested);
    }
}

pub(super) fn exit_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        state.exit_requested = true;
    }
    if let Some(error) = v8::String::new(scope, EXIT_SENTINEL) {
        scope.throw_exception(error.into());
    }
}
