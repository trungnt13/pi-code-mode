# Third-party notices

## OpenAI Codex code-mode host source and patch

`vendor/codex/code-mode-host/codex-rs`, historical
`vendor/codex/codex-code-mode-host.patch`, `vendor/codex/LICENSE`, and
`vendor/codex/NOTICE` derive from OpenAI Codex. Standalone source was copied
from patched checkout `808d3c2702ce8eae007c457aa930e7c3b68dd5f6`;
patch baseline is `b5748e6e3cbc3c9831f84aa016486721b4923d1c`.
Codex is licensed under Apache License 2.0. Patch SHA-256:
`61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024`.

Selected upstream crate trees and test helper are retained with original
structure. Local workspace/compatibility manifests and lockfile make selected
source build independently from Codex checkout. Exact file classifications and
hashes are in `vendor/codex/code-mode-host/provenance.json`.

## Pi

Runtime protocol/client/scheduler design was adapted from code-mode work
originally developed against Pi. `src/native/transform-messages.ts` copies
Pi 0.81.1 message transformation logic with its type import adapted to Pi's
public package entry point and one behavior-equivalent loop syntax change.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## @howaboua/pi-codex-conversion

Native freeform provider contract and Responses stream handling were adapted
from `@howaboua/pi-codex-conversion` commit
`3d55dffaf22a47854f568d3d2d742b979cfbc55f`.

MIT License

Copyright (c) 2026 Igor Warzocha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
