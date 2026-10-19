const { addTax } = require("./money");

class Invoice {
  constructor(lines, rate) {
    this.lines = lines;
    this.rate = rate;
  }

  total() {
    const net = this.lines.reduce((sum, l) => sum + l.qty * l.price, 0);
    return addTax(net, this.rate);
  }
}

module.exports = { Invoice };
