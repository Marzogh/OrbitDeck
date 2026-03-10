# Maintainer Guide

## Repo hygiene

Keep the public repo focused on shippable product files.

Do not track:

- runtime state under `data/state.json`
- cached snapshots under `data/snapshots/`
- internal proposal and review logs under `docs/*proposal*.md`, `docs/*review-log.md`, and `docs/*redesign-log.md`
- generated MkDocs output under `site/`

## Documentation rule

When product behavior changes, update both:

- `README.md`
- `docs/INSTALL_AND_RUN.md`

If the change affects the docs site structure or quick-start workflow, update the relevant MkDocs pages too.

## Useful validation

Backend:

```bash
pytest -q
```

Frontend syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/kiosk.js
node --check app/static/kiosk/rotator.js
```

Docs build:

```bash
mkdocs build --strict
```
