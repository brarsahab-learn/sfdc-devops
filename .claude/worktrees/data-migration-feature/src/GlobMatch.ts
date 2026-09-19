// GlobMatch.ts
// Minimal glob matcher for the packaging.patchOverrides / packaging.excludedMetadata
// settings (e.g. "**/classes/*ErrorWorkaround*", "**/profiles/**"). Deliberately
// hand-rolled instead of pulling in a dependency — this extension ships with zero
// runtime dependencies today and the subset of glob syntax these settings need
// ("**", "*", "?") is small enough not to be worth a package.

function globToRegExp(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                out += ".*";
                i++;
                // Swallow an immediately following slash so "**/foo" also matches "foo" at the root.
                if (pattern[i + 1] === "/") { i++; }
            } else {
                out += "[^/]*";
            }
        } else if (c === "?") {
            out += "[^/]";
        } else {
            out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${out}$`);
}

/** True if `filePath` (repo-relative, forward slashes) matches any of `patterns`. */
export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return patterns.some(p => globToRegExp(p).test(normalized));
}
