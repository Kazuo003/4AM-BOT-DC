const { nanoid } = require('nanoid');
function shortOrderNo() { return nanoid(8).toUpperCase(); }
function specToLines(spec) {
  return Object.entries(spec).map(([k,v]) => `• **${k}**: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
}
module.exports = { shortOrderNo, specToLines };