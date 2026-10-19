/** Rounds to two decimals the way the old invoices did (half up). */
function round2(x) {
  return Math.round(x * 100) / 100;
}

function addTax(net, rate) {
  return round2(net * (1 + rate));
}

module.exports = { round2, addTax };
