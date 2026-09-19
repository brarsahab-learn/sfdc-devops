/**
 * Seeds sample Client Locations. pc-10trillion had no pre-existing Location
 * data to capture, so these are representative placeholders linked to the
 * first available Insurer account.
 *
 * Run with:
 *   sf apex run --file data-migration/apex/seed-locations.apex --target-org <org>
 *
 * Safe to re-run: existing locations with the same City__c are skipped.
 *
 * Namespace-agnostic: anonymous Apex is compiled fresh in the *running org's*
 * default context, not inside the package's namespace - so it can only use
 * strongly-typed sObject syntax (e.g. `new Client_Location__c(...)`) when run
 * in an org that owns the "InsureBridge" namespace (like a scratch org used
 * to develop the package). In a genuine subscriber org where the package is
 * installed, only the namespaced name (InsureBridge__Client_Location__c)
 * actually exists, so strongly-typed syntax would fail to compile. This
 * script instead resolves the object/field API names dynamically and does
 * everything through generic SObjects, so the same script works unmodified
 * in both cases.
 */
Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();
String nsPrefix = globalDescribe.containsKey('Client_Location__c') ? '' : 'InsureBridge__';
Schema.SObjectType clientLocationType = globalDescribe.get(nsPrefix + 'Client_Location__c');

Id insurerRTId = Schema.SObjectType.Account.getRecordTypeInfosByDeveloperName()
    .get('Insurer')
    .getRecordTypeId();
List<Account> anchorAccounts = [SELECT Id FROM Account WHERE RecordTypeId = :insurerRTId LIMIT 1];
Account anchorAccount = anchorAccounts.isEmpty() ? null : anchorAccounts[0];

String cityField = nsPrefix + 'City__c';
String streetField = nsPrefix + 'Street_Address__c';
String stateField = nsPrefix + 'State__c';
String countryField = nsPrefix + 'Country__c';
String pinField = nsPrefix + 'Pin_Code__c';
String accountField = nsPrefix + 'Account__c';

List<String> locationCities = new List<String>{ 'Mumbai', 'New Delhi', 'Bengaluru' };
Map<String, SObject> existingLocations = new Map<String, SObject>();
String existingQuery = 'SELECT Id, ' + cityField + ' FROM ' + clientLocationType.getDescribe().getName() +
    ' WHERE ' + cityField + ' IN :locationCities';
for (SObject l : Database.query(existingQuery)) {
    existingLocations.put((String) l.get(cityField), l);
}

Map<String, Map<String, String>> seedData = new Map<String, Map<String, String>>{
    'Mumbai' => new Map<String, String>{
        'street' => 'Plot 12, MIDC Industrial Area', 'state' => 'Maharashtra', 'pin' => '400093'
    },
    'New Delhi' => new Map<String, String>{
        'street' => 'Sector 44, Udyog Vihar', 'state' => 'Delhi', 'pin' => '110044'
    },
    'Bengaluru' => new Map<String, String>{
        'street' => 'Electronic City Phase 1', 'state' => 'Karnataka', 'pin' => '560100'
    }
};

List<SObject> locationsToInsert = new List<SObject>();
for (String city : locationCities) {
    if (existingLocations.containsKey(city)) {
        continue;
    }
    Map<String, String> seed = seedData.get(city);
    SObject loc = clientLocationType.newSObject();
    loc.put(streetField, seed.get('street'));
    loc.put(cityField, city);
    loc.put(stateField, seed.get('state'));
    loc.put(countryField, 'India');
    loc.put(pinField, seed.get('pin'));
    loc.put(accountField, anchorAccount != null ? anchorAccount.Id : null);
    locationsToInsert.add(loc);
}
if (!locationsToInsert.isEmpty()) {
    insert locationsToInsert;
}
System.debug('Locations ready: ' + (existingLocations.size() + locationsToInsert.size()));
