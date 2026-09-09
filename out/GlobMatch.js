"use strict";
// GlobMatch.ts
// Minimal glob matcher for the packaging.patchOverrides / packaging.excludedMetadata
// settings (e.g. "**/classes/*ErrorWorkaround*", "**/profiles/**"). Deliberately
// hand-rolled instead of pulling in a dependency — this extension ships with zero
// runtime dependencies today and the subset of glob syntax these settings need
// ("**", "*", "?") is small enough not to be worth a package.
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchesAnyGlob = matchesAnyGlob;
function globToRegExp(pattern) {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                out += ".*";
                i++;
                // Swallow an immediately following slash so "**/foo" also matches "foo" at the root.
                if (pattern[i + 1] === "/") {
                    i++;
                }
            }
            else {
                out += "[^/]*";
            }
        }
        else if (c === "?") {
            out += "[^/]";
        }
        else {
            out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${out}$`);
}
/** True if `filePath` (repo-relative, forward slashes) matches any of `patterns`. */
function matchesAnyGlob(filePath, patterns) {
    const normalized = filePath.replace(/\\/g, "/");
    return patterns.some(p => globToRegExp(p).test(normalized));
}
//# sourceMappingURL=GlobMatch.js.map