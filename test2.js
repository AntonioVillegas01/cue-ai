/**
 * @param {string} str
 * @return {string|null}
 */
function firstUniqueChar(str) {
    const counts = new Map();
    for (const char of str) {
        counts.set(char, (counts.get(char) || 0) + 1);
    }
    for (const [char, count] of counts) {
        if (count === 1) {
            return char;
        }
    }
    return null;
}

console.log(firstUniqueChar("aabbcddee")); // "c"
console.log(firstUniqueChar("abcabc"));    // null
console.log(firstUniqueChar("javascript")); // "j"
console.log(firstUniqueChar("aabbccx"));   // "x"
