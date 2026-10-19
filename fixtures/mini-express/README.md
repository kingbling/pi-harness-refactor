# mini-express fixture

A deliberately small legacy Node.js (Express) app, so tests run the pipeline on a source that is not PHP:

- `lib/money.js` — pure helper
- `lib/invoice.js` — domain class that uses the helper
- `lib/handlers.js` — route handler
- `index.js` — the Express app and its route (`app.get("/invoices/total", invoiceTotal)`)
- `old/export.js` — dead code (nothing reaches it)

Express is not installed: the index never runs, the lib files run without it. Nothing here is production code.
