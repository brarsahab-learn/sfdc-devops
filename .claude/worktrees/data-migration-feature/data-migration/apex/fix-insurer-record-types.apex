/**
 * Post-import fixup for data-migration/seed/plan.json.
 *
 * Account.RecordTypeId and Contact.RecordTypeId are org-specific, so the
 * exported tree data intentionally omits them (a tree-import file can only
 * hardcode a source-org Id, which would silently misassign or fail on
 * another org). This sets the Insurer / Insurer Contact record types on the
 * records the import just created, resolved dynamically for this org.
 *
 * Run with:
 *   sf apex run --file data-migration/apex/fix-insurer-record-types.apex --target-org <org>
 *
 * Safe to re-run: only touches records that don't already have the right
 * record type.
 */
Id insurerRTId = Schema.SObjectType.Account.getRecordTypeInfosByDeveloperName()
    .get('Insurer')
    .getRecordTypeId();

List<String> insurerNames = new List<String>{
    'Acko General Insurance Limited',
    'Aditya Birla Health Insurance Co. Ltd.',
    'Agriculture Insurance Company of India Limited',
    'Bajaj Allianz General Insurance Company Limited',
    'Care Health Insurance Ltd.',
    'Cholamandalam MS General Insurance Company Limited',
    'Digit General Insurance Limited',
    'ECGC Limited',
    'Future Generali India Insurance Company Limited',
    'Galaxy Health Insurance Company Limited',
    'HDFC ERGO General Insurance Company Limited',
    'ICICI Lombard General Insurance Company Limited',
    'IFFCO TOKIO General Insurance Company Limited',
    'Kshema General Insurance Limited',
    'Liberty General Insurance Limited',
    'Magma General Insurance Limited',
    'Manipal Cigna Health Insurance Company Limited',
    'Narayana Health Insurance Ltd.',
    'National Insurance Company Limited',
    'Navi General Insurance Limited',
    'Niva Bupa Health Insurance Co Ltd.',
    'Raheja QBE General Insurance Co. Ltd.',
    'Reliance General Insurance Company Limited',
    'Royal Sundaram General Insurance Company Limited',
    'SBI General Insurance Company Limited',
    'Shriram General Insurance Company Limited',
    'Star Health & Allied Insurance Co.Ltd.',
    'Tata AIG General Insurance Company Limited',
    'The New India Assurance Company Limited',
    'The Oriental Insurance Company Limited',
    'United India Insurance Company Limited',
    'Universal Sompo General Insurance Company Limited',
    'Zuno General Insurance Ltd.',
    'Zurich Kotak General Insurance Company (India) Limited'
};

List<Account> insurerAccounts = [
    SELECT Id, RecordTypeId
    FROM Account
    WHERE Name IN :insurerNames AND RecordTypeId != :insurerRTId
];
for (Account a : insurerAccounts) {
    a.RecordTypeId = insurerRTId;
}
if (!insurerAccounts.isEmpty()) {
    update insurerAccounts;
}
System.debug('Insurer Accounts fixed: ' + insurerAccounts.size());

Set<Id> insurerAccountIds = new Set<Id>();
for (Account a : [SELECT Id FROM Account WHERE Name IN :insurerNames]) {
    insurerAccountIds.add(a.Id);
}

Id insurerContactRTId = Schema.SObjectType.Contact.getRecordTypeInfosByDeveloperName()
    .get('Insurer_Contact')
    .getRecordTypeId();

List<Contact> insurerContacts = [
    SELECT Id, RecordTypeId
    FROM Contact
    WHERE AccountId IN :insurerAccountIds AND RecordTypeId != :insurerContactRTId
];
for (Contact c : insurerContacts) {
    c.RecordTypeId = insurerContactRTId;
}
if (!insurerContacts.isEmpty()) {
    update insurerContacts;
}
System.debug('Insurer Contacts fixed: ' + insurerContacts.size());
