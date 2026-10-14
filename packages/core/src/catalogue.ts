// The national subject catalogue (plan: "The 2025 lists", "Beyond the 2025 lists"): NERDC 2025
// curriculum offerings and the legacy subjects older classes still take. Names as NERDC publishes
// them. Platform data: schools read it and never change it. A change ships as a code change, like a
// seed migration (docs/decisions.md #5). Entry ids are stable: schools' subjects point at them.
import type { Band, CatalogueEntry, Role } from "./subjects.js";

const PRIMARY: Band[] = ["lowerPrimary", "upperPrimary"];
const offers = (bands: Band[], role: Role) => bands.map((band) => ({ band, role }));

const languages: CatalogueEntry[] = ["Hausa", "Igbo", "Yoruba"].map((name) => ({
  id: name.toLowerCase(),
  name,
  code: name.slice(0, 3).toUpperCase(),
  tag: "nerdc2025",
  set: "Nigerian language",
  offers: [...offers([...PRIMARY, "junior"], "choice"), { band: "senior", role: "humanities" }],
}));

const trades: CatalogueEntry[] = [
  ["solar-pv", "Solar PV Installation and Maintenance", "SPV"],
  ["fashion-design", "Fashion Design and Garment Making", "FDG"],
  ["livestock-farming", "Livestock Farming", "LVF"],
  ["beauty-cosmetology", "Beauty and Cosmetology", "BCO"],
  ["computer-hardware-gsm", "Computer Hardware and GSM Repairs", "CHG"],
  ["horticulture", "Horticulture and Crop Production", "HCP"],
].map(([id, name, code]) => ({ id: id!, name: name!, code: code!, tag: "nerdc2025", set: "Trade", offers: offers(["junior", "senior"], "choice") }));

const entry = (id: string, name: string, code: string, offerList: { band: Band; role: Role }[], set?: string): CatalogueEntry => ({ id, name, code, tag: "nerdc2025", offers: offerList, ...(set ? { set } : {}) });
const legacy = (id: string, name: string, code: string, bands: Band[]): CatalogueEntry => ({ id, name, code, tag: "legacy", offers: offers(bands, "core") });

export const CATALOGUE: CatalogueEntry[] = [
  // Primary and junior
  entry("english-studies", "English Studies", "ENG", offers([...PRIMARY, "junior"], "core")),
  entry("mathematics", "Mathematics", "MTH", offers([...PRIMARY, "junior"], "core")),
  ...languages,
  entry("basic-science", "Basic Science", "BSC", offers(["lowerPrimary"], "core")),
  entry("basic-science-technology", "Basic Science and Technology", "BST", offers(["upperPrimary"], "core")),
  entry("intermediate-science", "Intermediate Science", "ISC", offers(["junior"], "core")),
  entry("physical-health-education", "Physical and Health Education", "PHE", offers([...PRIMARY, "junior"], "core")),
  entry("crs", "Christian Religious Studies", "CRS", [...offers([...PRIMARY, "junior"], "choice"), { band: "senior", role: "humanities" }], "Religion"),
  entry("islamic-studies", "Islamic Studies", "IRS", [...offers([...PRIMARY, "junior"], "choice"), { band: "senior", role: "humanities" }], "Religion"),
  entry("nigerian-history", "Nigerian History", "NHI", [...offers([...PRIMARY, "junior"], "core"), { band: "senior", role: "humanities" }]),
  entry("social-citizenship", "Social and Citizenship Studies", "SCS", offers([...PRIMARY, "junior"], "core")),
  entry("cultural-creative-arts", "Cultural and Creative Arts", "CCA", offers([...PRIMARY, "junior"], "core")),
  entry("basic-digital-literacy", "Basic Digital Literacy", "BDL", offers(["upperPrimary"], "core")),
  entry("pre-vocational", "Pre-vocational Studies", "PVS", offers(["upperPrimary"], "core")),
  entry("digital-technologies", "Digital Technologies", "DTE", offers(["junior", "senior"], "core")),
  entry("business-studies", "Business Studies", "BUS", offers(["junior"], "core")),
  entry("french", "French", "FRE", [...offers(["upperPrimary", "junior"], "optional"), { band: "senior", role: "humanities" }]),
  entry("arabic", "Arabic", "ARA", [...offers([...PRIMARY, "junior"], "optional"), { band: "senior", role: "humanities" }]),
  ...trades,
  // Senior core
  entry("english-language", "English Language", "ENL", offers(["senior"], "core")),
  entry("general-mathematics", "General Mathematics", "GMT", offers(["senior"], "core")),
  entry("citizenship-heritage", "Citizenship and Heritage Studies", "CHS", offers(["senior"], "core")),
  // Senior science
  entry("biology", "Biology", "BIO", offers(["senior"], "science")),
  entry("chemistry", "Chemistry", "CHE", offers(["senior"], "science")),
  entry("physics", "Physics", "PHY", offers(["senior"], "science")),
  entry("agriculture", "Agriculture", "AGR", offers(["senior"], "science")),
  entry("further-mathematics", "Further Mathematics", "FMT", offers(["senior"], "science")),
  entry("physical-education", "Physical Education", "PED", offers(["senior"], "science")),
  entry("health-education", "Health Education", "HED", offers(["senior"], "science")),
  entry("foods-nutrition", "Foods and Nutrition", "FNU", offers(["senior"], "science")),
  entry("geography", "Geography", "GEO", offers(["senior"], "science")),
  entry("technical-drawing", "Technical Drawing", "TDR", offers(["senior"], "science")),
  // Senior humanities
  entry("government", "Government", "GOV", offers(["senior"], "humanities")),
  entry("visual-arts", "Visual Arts", "VAR", offers(["senior"], "humanities")),
  entry("music", "Music", "MUS", offers(["senior"], "humanities")),
  entry("literature-english", "Literature in English", "LIT", offers(["senior"], "humanities")),
  entry("home-management", "Home Management", "HMG", offers(["senior"], "humanities")),
  entry("catering-craft", "Catering Craft", "CAT", offers(["senior"], "humanities")),
  // Senior business
  entry("accounting", "Accounting", "ACC", offers(["senior"], "business")),
  entry("commerce", "Commerce", "COM", offers(["senior"], "business")),
  entry("marketing", "Marketing", "MKT", offers(["senior"], "business")),
  entry("economics", "Economics", "ECO", offers(["senior"], "business")),
  // Legacy: what older classes still take
  legacy("civic-education", "Civic Education", "CIV", ["junior", "senior"]),
  legacy("social-studies", "Social Studies", "SOS", [...PRIMARY, "junior"]),
  legacy("basic-technology", "Basic Technology", "BTE", ["junior"]),
  legacy("computer-studies", "Computer Studies", "CST", [...PRIMARY, "junior", "senior"]),
  legacy("agricultural-science", "Agricultural Science", "AGS", ["junior", "senior"]),
  legacy("data-processing", "Data Processing", "DPR", ["senior"]),
  legacy("garment-making", "Garment Making", "GMK", ["senior"]),
  legacy("gsm-maintenance", "GSM Maintenance", "GSM", ["senior"]),
];
