# Kimetron Isle

**World-coordinate canvas engine — position is data.**

A framework-agnostic 2D placement engine for the web.
CAD-style world coordinates (real units, configurable origin, grid snap,
scale-based zoom) as first-class data — not screen pixels.

Early development. Nothing to install yet.

## Structure

| path | package | role |
|------|---------|------|
| `packages/core` | `@kimetron/core` | model, coordinate system, selection, drag, hit-testing, viewport (vanilla TS, no DOM) |
| `packages/dom` | `@kimetron/dom` | DOM + CSS transform renderer |
| `packages/react` | `@kimetron/react` | thin React adapter (components + hooks) |
| `drivers/` | — | sample applications that consume the engine (playground, and future sethera/plesfeda-style integrations) |

## Development

```sh
npm install
npm run dev        # playground (drivers/demo)
npm run typecheck  # all workspaces
npm run test       # vitest
npm run build      # all workspaces
```

## License

MIT
