/**
 * Resolves whether a target org expects unprefixed custom API names
 * (Product_Group__c - an org that owns the "InsureBridge" namespace, e.g. a
 * package-dev scratch org) or namespaced ones (InsureBridge__Product_Group__c
 * - a genuine subscriber org with the package installed), and rewrites
 * sObject/field API names accordingly.
 */
const { execFileSync } = require('child_process');

const NAMESPACE = 'InsureBridge__';

function objectExists(targetOrg, sobjectName) {
    try {
        execFileSync('sf', [
            'data', 'query',
            '--target-org', targetOrg,
            '--query', `SELECT Id FROM ${sobjectName} LIMIT 1`,
            '--json',
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * @param {string} targetOrg
 * @param {string} probeObject an unprefixed custom object API name known to exist in the package
 * @returns {string} '' or 'InsureBridge__'
 */
function resolveNamespacePrefix(targetOrg, probeObject) {
    if (objectExists(targetOrg, probeObject)) {
        return '';
    }
    if (objectExists(targetOrg, NAMESPACE + probeObject)) {
        return NAMESPACE;
    }
    throw new Error(
        `Neither '${probeObject}' nor '${NAMESPACE}${probeObject}' exist in org '${targetOrg}'. ` +
        `The package metadata likely hasn't been deployed/installed there yet.`
    );
}

function prefixCustomApiName(name, nsPrefix) {
    // Custom object/field API names end in "__c"; compound-field sub-fields
    // (e.g. a custom Address field's Street/City/PostalCode components) end
    // in "__s" and belong to the same namespace as their parent field.
    if (!name.endsWith('__c') && !name.endsWith('__s')) {
        return name; // standard field/object name - never namespaced
    }
    if (nsPrefix && name.startsWith(nsPrefix)) {
        return name; // already prefixed
    }
    return nsPrefix + name;
}

module.exports = { resolveNamespacePrefix, prefixCustomApiName, NAMESPACE };
