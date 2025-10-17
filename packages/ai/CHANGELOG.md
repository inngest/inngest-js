# @inngest/ai

## 0.1.7

### Patch Changes

- [#1134](https://github.com/inngest/inngest-js/pull/1134) [`68ceb0c9`](https://github.com/inngest/inngest-js/commit/68ceb0c9b84451596e81bceb506438d42af6f70e) Thanks [@tedjames](https://github.com/tedjames)! - added support for latest openai responses api

## 0.1.6

### Patch Changes

- [#1031](https://github.com/inngest/inngest-js/pull/1031) [`3d94247`](https://github.com/inngest/inngest-js/commit/3d94247307b274b36be629dcfcf77dc799a6e9eb) Thanks [@tedjames](https://github.com/tedjames)! - added support for latest thinking and generation config for gemini models
  created unit and smoke tests for AI models + adapters

- [#1049](https://github.com/inngest/inngest-js/pull/1049) [`8c84b8f`](https://github.com/inngest/inngest-js/commit/8c84b8f0981bb066ab4051e2aee3facac67dbb02) Thanks [@Anuj-K15](https://github.com/Anuj-K15)! - Add GPT-5 model variants (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`) to OpenAi type for improved type safety.

## 0.1.5

### Patch Changes

- [#961](https://github.com/inngest/inngest-js/pull/961) [`bf8ab80`](https://github.com/inngest/inngest-js/commit/bf8ab80fd4601fae6a71188821df1e40e89d541b) Thanks [@jonmagic](https://github.com/jonmagic)! - Add Azure OpenAI adapter and model support

  - Introduced a new `AzureOpenAiAiAdapter` type definition, following the OpenAI I/O format.
  - Registered `"azure-openai"` as a supported AI adapter format.
  - Implemented a `azureOpenai` model creator for Azure OpenAI, handling endpoint, deployment, and version configuration.
  - Added strongly typed input/output for Azure OpenAI, mirroring OpenAI’s message/completion shape.
  - Updated `adapters/index.ts` and `models/index.ts` to export new Azure OpenAI adapter/model.
  - Ensured Azure-specific request construction and parameterization in the model creator.

- [#1015](https://github.com/inngest/inngest-js/pull/1015) [`6f478be`](https://github.com/inngest/inngest-js/commit/6f478bee07bb96eea6e0153f04d4f9060b6b570d) Thanks [@tedjames](https://github.com/tedjames)! - added latest models to gemini & anthropic adapters

## 0.1.4

### Patch Changes

- [#962](https://github.com/inngest/inngest-js/pull/962) [`ef50e59`](https://github.com/inngest/inngest-js/commit/ef50e59de229f2e9b0748272f3caf8934a7fbd88) Thanks [@jonmagic](https://github.com/jonmagic)! - Add new GPT-4.1 models:

  - `gpt-4.1`
  - `gpt-4.1-mini`

## 0.1.3

### Patch Changes

- [#890](https://github.com/inngest/inngest-js/pull/890) [`fd03b00`](https://github.com/inngest/inngest-js/commit/fd03b009941cf89a4872447b6059d66ef585532a) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Export a `models` property containing all models

## 0.1.2

### Patch Changes

- [#884](https://github.com/inngest/inngest-js/pull/884) [`01788c6`](https://github.com/inngest/inngest-js/commit/01788c61c52dc139e33ec0e5277e417ea087e9e6) Thanks [@charlypoly](https://github.com/charlypoly)! - `@inngest/ai`: Gemini adapter + Grok OpenAI-compatible support

## 0.1.1

### Patch Changes

- [#880](https://github.com/inngest/inngest-js/pull/880) [`6520605`](https://github.com/inngest/inngest-js/commit/65206056f54b253bdee455756e29b9f808f59d64) Thanks [@charlypoly](https://github.com/charlypoly)! - fix(ai): `model` and `max_tokens` should be optional on `MessageCreateParamsBase` for `step.ai` APIs

## 0.1.0

### Minor Changes

- [#874](https://github.com/inngest/inngest-js/pull/874) [`6e8b258`](https://github.com/inngest/inngest-js/commit/6e8b258abe7eb48b8a46c6f15fdbc45f1441cbd3) Thanks [@charlypoly](https://github.com/charlypoly)! - feat(ai): add support for Anthropic Claude `"type": "document"` PDF parsing capabilities

## 0.0.5

### Patch Changes

- [#871](https://github.com/inngest/inngest-js/pull/871) [`58684e1`](https://github.com/inngest/inngest-js/commit/58684e19cd35271e5b5b8460443e363165155fe1) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Broaden adapter typing for better cross-package compatibility

- [#870](https://github.com/inngest/inngest-js/pull/870) [`62e6a85`](https://github.com/inngest/inngest-js/commit/62e6a85d37e12e5772fcec1a26adaf77dbe4d837) Thanks [@charlypoly](https://github.com/charlypoly)! - fix(ai): allow arbitrary model name for OpenAI + add "gpt-4.5-preview" to list

- [#869](https://github.com/inngest/inngest-js/pull/869) [`f446052`](https://github.com/inngest/inngest-js/commit/f4460528585f7f67c066fd7b8b7bdd87562014a0) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Allow setting default parameters for models

## 0.0.4

### Patch Changes

- [#850](https://github.com/inngest/inngest-js/pull/850) [`dfe5e2a`](https://github.com/inngest/inngest-js/commit/dfe5e2ad2938871bfd5db10bab082c4f513c2490) Thanks [@charlypoly](https://github.com/charlypoly)! - feat(ai): type error outputs

- [#850](https://github.com/inngest/inngest-js/pull/850) [`dfe5e2a`](https://github.com/inngest/inngest-js/commit/dfe5e2ad2938871bfd5db10bab082c4f513c2490) Thanks [@charlypoly](https://github.com/charlypoly)! - feat(ai): type error outputs

## 0.0.3

### Patch Changes

- [#816](https://github.com/inngest/inngest-js/pull/816) [`fadd94a`](https://github.com/inngest/inngest-js/commit/fadd94a998ae1e996941e88830d0f468fc649a85) Thanks [@joelhooks](https://github.com/joelhooks)! - Add Deepseek support

## 0.0.2

### Patch Changes

- [#808](https://github.com/inngest/inngest-js/pull/808) [`46d270f`](https://github.com/inngest/inngest-js/commit/46d270fc7f06e7443c954df6c293f4f18835b347) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add a license

## 0.0.1

### Patch Changes

- [#802](https://github.com/inngest/inngest-js/pull/802) [`32518bf`](https://github.com/inngest/inngest-js/commit/32518bf6558090379b367c1b8c1540c05755b657) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `@inngest/ai`
