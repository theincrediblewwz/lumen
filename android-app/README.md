# LearnStuff Android

The native Android MVP is an Expo Router application backed by on-device SQLite.

## Run in Expo Go

```bash
npm ci
npm start
```

Press `a` after Metro starts to open the connected Android emulator.

## Checks

```bash
npm run typecheck
npm run lint
npm run test:contracts
npm run doctor
npm run export:android
```

## Current source and installable previews

The source is version **2.1.0-preview.8 / versionCode 23**, package `com.learnstuffquickly.app`. It includes rich-document/PDF import, original-asset preservation, knowledge exchange and the existing local canvas/discussion/sync workflows. This source synchronization does not replace any frozen release asset or change the Android signing identity.

The older public [2.1.0-preview.3 APK](https://github.com/theincrediblewwz/lumen/releases/tag/android-v2.1.0-preview.3) remains available, but is not a binary build of this newer source. See [installation and data preservation](../docs/ANDROID-PREVIEW.md) before changing installations. Preview builds use a test certificate and are not Play Store production builds; same-package updates require the same signing certificate.

## Optional remote services

Local learning works without a Gateway. A personal OpenAI-compatible connection can be configured in the app at runtime; keys belong in device SecureStore and are not build inputs. Optional Gateway integration and its protocol tests remain in the client, but the separate Gateway service and its development launcher are not included in this public repository. To run `npm run test:gateway`, supply a separately operated compatible test service; the public source has no preconfigured service or provider credential.

Before an AI request, the app displays the data scope and destination for the user to approve. Opening text or a draft does not send it automatically. Direct BYOK requests are not automatically replayed after ambiguous network failures or malformed model output. Cross-device WebDAV requires an explicitly configured service; do not treat synthetic protocol tests as proof of a particular real server or phone background behavior.

## Current functional slice

- List and create learning projects.
- Persist projects, Markdown documents, graph nodes, and graph edges in SQLite.
- Pan and pinch-zoom the native knowledge canvas.
- Select a node or relationship and open its Markdown document.
- Mark a relationship as unverified, helpful to the current learner, or disputed; the local review persists without claiming factual verification.
- Edit learner-authored Markdown without overwriting source provenance.
- Import a bounded local Markdown folder as a new graph, or restore a strict LearnStuff portable graph v1 without overwriting existing projects.
- Export standalone node/edge Markdown, saved answers, and `learnstuff.graph.json` to a user-selected Android folder.
- Save and edit question templates, fill them from the node composer, and explicitly bookmark node answer snapshots for export.
- Expand a selected node through the same durable job pipeline using personal BYOK, the HTTP Gateway, or a clearly labeled local adapter.
- Validate a versioned graph patch and commit it atomically with its job result.

The Android BYOK adapter supports generic OpenAI-compatible Chat Completions without importing provider SDKs or credentials into the bundle. Arbitrary endpoint live behavior remains provider-specific and must be verified by the owner through the explicit connection test.

## Offline knowledge-format exchange

The repository includes the offline product bridge `../scripts/knowledge_exchange.py` and its pinned schema under `../contracts/historyandknowledge/`. Install the locked Python dependencies and set `LSQ_EXCHANGE_PYTHON` as described in the [repository guide](../README.md#离线知识格式交换), then run `npm run test:knowledge-exchange`. This is a self-contained product-format test, not an excluded external service.

This source update also aligns the Android shared knowledge core with the desktop iterative dependency traversal and required-reference propagation. It preserves the existing knowledge contract and tests; no new APK is issued by this source synchronization.
