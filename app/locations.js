// locations.js — the buildings this app serves.
//
// A location is a COMPLETE, SEPARATE instance: its own ledger, its own Cash On
// Hand, its own staff, its own deposit items, its own Travelista record and its
// own backup file. Nothing is shared between buildings except the code, the
// device's GitHub token, and the admin credentials (an owner signs in at either).
//
// Main deliberately keeps the ORIGINAL storage keys and backup path. That is what
// makes adding a second building a zero-risk change to the live 18k-entry record:
// every existing device keeps reading and writing exactly what it always has.
export const LOCATIONS = {
  main: {
    id: 'main',
    name: 'Frendz Hostel Main',
    short: 'Main',
    icon: '🏠',
    // storage identity (UNCHANGED from before locations existed)
    idbKey: 'state',
    lsKey: 'fdtt_state_v1',
    sessionKey: 'fdtt_session',
    backupPath: 'data/ledger-backup.json',
    // which deposit item carries a physical tag number
    tagItems: ['towel'],
    // Managers who run BOTH buildings are seeded at both. Stored as a salted hash,
    // never the plaintext — this repository is public.
    seedAdmins: [
      { id: 'admin_louise', name: 'Louise', pinHash: 'bfl26$037e0c3f8d7ae21ead02443cc746d777226fdd8384ffab4e25d44ae1d1c7d519' },
    ],
    // non-cash collateral: what it is called here, and what must be recorded
    collateral: {
      key: 'passport',
      label: 'Passport',
      icon: '🛂',
      refLabel: 'MEWS reservation #',
      refPlaceholder: 'e.g. RES-48213',
      refHint: 'required — the booking this passport is held against',
      pageTitle: 'Passports held',
      pageNav: 'Passports',
      noun: 'passport',
    },
    // Main was provisioned from the hostel's historical spreadsheet.
    seedFromOfficialCsv: true,
    // the Aug 1-15 travelista sheet belongs to Main only
    seedTravelistaSheet: true,
    // Main's existing "Booked By" list. A new building starts with an empty one
    // and adds its own people as they book.
    seedBookers: ['MARIE', 'BECCA', 'DARREN', 'GINO', 'CHALYN', 'MONIE'],
    seedItems: [
      { name: 'Towel', defaultAmount: 200 },
      { name: 'Padlock', defaultAmount: 100 },
      { name: 'Hair Dryer', defaultAmount: 500 },
    ],
  },
  beachfront: {
    id: 'beachfront',
    name: 'Frendz Hostel Beachfront',
    short: 'Beachfront',
    icon: '🏖️',
    idbKey: 'state:beachfront',
    lsKey: 'fdtt_state_beachfront',
    sessionKey: 'fdtt_session_beachfront',
    backupPath: 'data/beachfront-backup.json',
    tagItems: ['beach towel'],
    collateral: {
      key: 'id',
      label: 'Valid ID',
      icon: '🪪',
      refLabel: 'ID type & number',
      refPlaceholder: "e.g. Driver's licence N01-234567",
      refHint: 'required — what ID is being held, so it can be returned to the right guest',
      pageTitle: 'IDs held',
      pageNav: 'IDs Held',
      noun: 'ID',
    },
    // A brand-new building starts EMPTY — no historical import, no opening float,
    // and deposit amounts at 0 until the team sets them (or imports their sheet).
    seedFromOfficialCsv: false,
    seedTravelistaSheet: false,
    seedBookers: [],
    // The building's first admin. Seeded as a SALTED HASH, never the plaintext —
    // this repository is public, so a password committed here would be a
    // published password. Louise can change it herself under Settings → Security.
    seedAdmins: [
      { id: 'admin_bf_louise', name: 'Louise', pinHash: 'bfl26$037e0c3f8d7ae21ead02443cc746d777226fdd8384ffab4e25d44ae1d1c7d519' },
    ],
    // A building with no staff accounts yet must NOT be an open desk — see
    // requireStaffPin in ensureFreshBuilding().
    seedItems: [
      { name: 'Beach Towel', defaultAmount: 0 },
      { name: 'Umbrella', defaultAmount: 0 },
      { name: 'Hairdryer', defaultAmount: 0 },
      { name: 'Steamer', defaultAmount: 0 },
      { name: 'Electric Kettle', defaultAmount: 0 },
    ],
  },
};

export const LOCATION_KEY = 'fdtt_location'; // device-local: which building this device works in
export const DEFAULT_LOCATION = 'main';
export const locationList = () => Object.values(LOCATIONS);
export const locationById = (id) => LOCATIONS[id] || null;
