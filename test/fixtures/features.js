var authLog = [];
function authToken(u) { return "tok-" + u; }
var alice = authToken("alice");
authLog.push(alice);
console.log("A:" + JSON.stringify(authLog));
var cartLog = [];
function cartTotal(items) { return items.reduce(function (a, b) { return a + b; }, 0); }
var sum = cartTotal([4, 5, 6]);
cartLog.push(sum);
console.log("B:" + JSON.stringify(cartLog));
