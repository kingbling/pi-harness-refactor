const { Invoice } = require("./invoice");

function invoiceTotal(req, res) {
  const invoice = new Invoice(JSON.parse(req.query.lines || "[]"), 0.2);
  res.json({ total: invoice.total() });
}

module.exports = { invoiceTotal };
