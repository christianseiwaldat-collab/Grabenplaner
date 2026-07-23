"use strict";

const catalog = require("./catalog");
const evaluator = require("./evaluator");
const receipt = require("./receipt");

module.exports = {
  ...catalog,
  ...evaluator,
  ...receipt,
};
