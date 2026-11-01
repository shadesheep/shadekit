export interface LocaleData {
  surnames: readonly string[];
  givenNamesSingle: readonly string[];
  givenNamesDouble: readonly string[];
  phonePrefixes: readonly string[];
  emailDomains: readonly string[];
  provinceCities: Record<string, readonly string[]>;
  districts: readonly string[];
  streets: readonly string[];
  companyNames: readonly string[];
  companyIndustries: readonly string[];
  companySuffixes: readonly string[];
  departments: readonly string[];
  positions: readonly string[];
  currencies: readonly string[];
  male: string;
  female: string;
}
