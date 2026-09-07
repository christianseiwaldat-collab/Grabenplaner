"use strict";
const C = require("./data-import-contract");
const { tableFor } = require("./tradefoto-master-profiles");
// Read-only business projections over ALREADY authorized segments. Original
// typed fields remain alongside these projections; no operational price, consent,
// employment or account balance is inferred from legacy flags.
const pick = (source, mapping) => Object.fromEntries(Object.entries(mapping).map(([target, field]) => [target, source[field] ?? null]));
const contacts = (source, mapping) => Object.entries(mapping).flatMap(([purpose, [type, field]]) => source[field] === null || source[field] === undefined || source[field] === "" ? []
  : [{ type, purpose, value: source[field], verified: false, sourceField: field }]);
const terms = source => ({ netDays: source.NettoTage ?? source.Nettotage ?? null,
  cashDiscounts: [1, 2, 3].map(index => ({ stage: index, days: source["SkontoT" + index] ?? null, percent: source["SkontoP" + index] ?? null })),
  priceGroup: source.Preisgruppe ?? null, rebateGroup: source.Rabattgruppe ?? null, paymentMethod: source.Zahlungsart ?? null,
  operationallyApplied: false });
function buildTradeFotoMasterView(inspected) {
  const table = tableFor(inspected.sourceTable), source = Object.assign({}, ...Object.values(inspected.segments));
  const view = { id: inspected.id, revision: inspected.revision, kind: table.group, provenance: "imported_source",
    relations: inspected.relations, sourceSegments: inspected.segments, omittedSegments: inspected.omittedSegments,
    partial: inspected.omittedSegments.length > 0 };
  if (table.name === "KUNDEN") {
    view.customer = pick(source, { accountNumber: "KUND_NR", firstName: "VORNAME", lastName: "NACHNAME", street: "STRaße", addressSupplement: "AdressZusatz", postalCode: "PLZ", city: "ORT", country: "Land", vatId: "UStID", birthCivilDateTime: "Geburtstag" });
    view.contacts = contacts(source, { mainPhone: ["phone", "TELEFON"], mobile: ["phone", "Handy"], fax: ["fax", "TELEFAX"], email: ["email", "EMail"], billingEmail: ["email", "EMailRechnung"] });
    view.conditions = terms(source);
    view.consent = { legacyNewsletterFlag: source.Newsletter ?? null, grantsConsent: false };
    view.website = null; view.customerTypeRequiresDecision = false;
  } else if (table.name === "Kunden_Lieferadresse") {
    view.address = pick(source, { sourceCustomerNumber: "KID", sourceAddressId: "LID", isDefault: "Standard", companyName: "Firma", firstName: "Vorname", lastName: "Nachname", line1: "Adresse1", line2: "Adresse2", postalCode: "PLZ", city: "Ort", country: "Land", phone: "Telefon" });
  } else if (table.name === "LIEFERANTEN") {
    view.supplier = pick(source, { sourceCode: "Suchname", legacyNumericId: "Lieferant_ID", companyName: "Firma", ownCustomerNumber: "KundenNummer", vatId: "ustid" });
    view.contacts = contacts(source, { phone: ["phone", "FTelefon"], mobile: ["phone", "FHandy"], fax: ["fax", "FTelefax"], email: ["email", "FEMail"], website: ["website", "FHomepage"] });
    view.conditions = terms(source);
  } else if (table.name === "LIEFERANTEN_Adressen") {
    view.address = pick(source, { sourceSupplierCode: "Suchname", sourceAddressNumber: "Nr", purpose: "Funktion", line1: "A1", line2: "A2", line3: "A3", postalCode: "PLZ", city: "ORT", country: "Land" });
    view.contacts = contacts(source, { phone: ["phone", "Telefon"], mobile: ["phone", "Handy"], fax: ["fax", "Telefax"], email: ["email", "EMail"] });
  } else if (table.name === "LIEFERANTEN_Konditionen") {
    view.conditions = { sourceSupplierCode: source.Suchname ?? null, code: source.Kondition ?? null,
      invoiceDiscounts: [1, 2, 3, 4].map(stage => ({ stage, code: source["R" + stage] ?? null, value: source["Rabatt" + stage] ?? null })),
      operationallyApplied: false, arithmeticRequiresReview: true };
  } else if (table.name === "ARTIKEL_STAMM") {
    view.articleExtension = pick(source, { sourceArticleKey: "EAN", sourceDescription: "Artikelbezeichnung", explanation: "Erklärung", shortDescription: "AKurzbeschreibung", deliveryContents: "ALieferumfang", brand: "Marke", assortmentCode: "Sortiment", supplierCode: "Suchname", orderNumber: "Bestellnummer", unit: "Einheit" });
    view.centralCatalogIsAuthoritative = true;
    view.mediaReferences = source.ABild ? [{ reference: source.ABild, contentAvailable: false, fetched: false }] : [];
  } else if (table.name === "MITARBEITER") {
    view.employeeReference = pick(source, { sourceSellerNumber: "Verkäufer_ID", firstName: "VORNAME", lastName: "NACHNAME", sourceLocationNumber: "FilialNr" });
    view.changesGpEmploymentOrRights = false;
  } else if (table.name === "FILIALEN") {
    view.locationReference = pick(source, { sourceLocationNumber: "FilialID", name: "FName", street: "Straße", postalCode: "PLZ", city: "Ort" });
    view.changesGpLocationSettings = false;
  }
  return C.freeze(view);
}
module.exports = { buildTradeFotoMasterView };
