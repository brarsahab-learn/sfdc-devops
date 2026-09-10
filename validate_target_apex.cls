/*
 * Anonymous Apex: validate migration by counting records with ExternalId__c
 * populated in the TARGET org. Run against the target org after a data migration.
 *
 * Run via: sf apex run --file validate_target_apex.cls --target-org <target-alias>
 */
List<String> objApiNames = new List<String>{
    'Product_Group__c',
    'Team__c',
    'Component_Master__c',
    'Broker__c',
    'Account',
    'Broker_Office_Location__c',
    'Contact',
    'Product__c',
    'Product_Component__c',
    'Product_Team_Mapping__c',
    'Product_Insurer_Mapping__c'
};

System.debug('=== Migration Validation Report ===');
System.debug('Target Org: ' + UserInfo.getOrganizationId() + ' / ' + UserInfo.getOrganizationName());
Integer totalRecords = 0;
Integer objectsWithData = 0;

for (String objApiName : objApiNames) {
    try {
        String query = 'SELECT COUNT() FROM ' + objApiName + ' WHERE ExternalId__c != null';
        Integer recordCount = Database.countQuery(query);
        String status = recordCount > 0 ? '✓' : '○';
        System.debug(status + ' ' + objApiName + ': ' + recordCount + ' record(s) with ExternalId__c');
        totalRecords += recordCount;
        if (recordCount > 0) { objectsWithData++; }
    } catch (Exception e) {
        System.debug('✗ ' + objApiName + ': ERROR - ' + e.getMessage());
    }
}

System.debug('');
System.debug('Total: ' + totalRecords + ' records migrated across ' + objectsWithData + '/' + objApiNames.size() + ' objects');
System.debug('Compare with tracking page in VS Code extension.');
