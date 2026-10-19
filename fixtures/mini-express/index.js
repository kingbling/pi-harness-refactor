const express = require("express");
const { invoiceTotal } = require("./lib/handlers");

const app = express();
app.get("/invoices/total", invoiceTotal);
app.listen(3000);
