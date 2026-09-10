/*
 * Anonymous Apex: for each of the migration source objects, count how many
 * records have ExternalId__c populated (ExternalId__c != null).
 *
 * Run via: sf apex run --file CountExternalIdRecords.apex
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

for (String objApiName : objApiNames) {
    try {
        String query = 'SELECT COUNT() FROM ' + objApiName + ' WHERE ExternalId__c != null';
        Integer recordCount = Database.countQuery(query);
        System.debug(objApiName + ': ' + recordCount + ' record(s) with ExternalId__c populated');
    } catch (Exception e) {
        System.debug('Error querying ' + objApiName + ' - ' + e.getMessage());
    }
}
