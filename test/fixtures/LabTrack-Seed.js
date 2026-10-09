/**
 * LabTrack-Seed — deterministic fixture generator for the LabTrack domain (design 08 §1, E3;
 * internal-contracts §31).
 *
 * Tables (test/fixtures/LabTrack-Model.json, standard audit columns + Deleted unless noted):
 *   Customer (tenant root), User, LabQueue, LabQueueMember, MaterialType, MaterialIntake,
 *   LabFormType (global lookup: no Deleted, no IDCustomer), MaterialIntakeRequirement,
 *   MaterialTypeFormRequirement, LabForm (owner-scoped: PersonalScopes OwnerIDUser).
 * Tenancy column IDCustomer; two tenants (1 and 2).
 *
 * Same API as Bookstore-Seed (internal-contracts §31.6):
 *   model(), generate({ Seed, Scale }), build(pDB, { Seed, Scale })   (+ Principals)
 *
 * The story (fixed IDs, the same at every Scale):
 *   Tech (user 1) is an ACTIVE member of queues 1 and 2, INACTIVE in 3, has a SOFT-DELETED
 *   membership in 4, and an active membership in the SOFT-DELETED queue 5 (its intakes must drop
 *   out); Colleague (2) is active in queue 1 (shared with Tech) and 6; Newbie (3) is in no queue.
 *   Intake 1 is soft-deleted with live requirements (they must drop out); intake 2 sits in the
 *   soft-deleted queue; intake 3 has no queue; intake 4 sits in a tenant-2 queue (cross-tenant).
 *   Every requirement of an intake in queue 1 or 2 gets one LabForm CASE, cycling through:
 *     0 none                                  → still to do
 *     1 Pending by Tech                        → still to do; Started for Tech
 *     2 Complete by Tech                       → done
 *     3 Complete by Colleague                  → done only through TenantOnly (Traps.ColleagueCompleted)
 *     4 Complete by Tech, SOFT-DELETED         → still to do
 *     5 Complete in TENANT 2 (OtherTech)       → still to do (invisible)
 *     6 Pending by Colleague + a Tech form with Status NULL → still to do; NOT started for Tech
 *       (Colleague's form is owner-scoped away; NULL ≠ 'Complete' is unknown)
 *     7 Pending by Tech + Complete by Newbie   → done (TenantOnly); Started for Tech
 *   MaterialTypeFormRequirement for type 1: forms 1, 2, 2 (a DUPLICATE (type, form) row: the
 *   TuplePivot distinct-key trap), 3 (Required 0) and 5 (SOFT-DELETED); a tenant-2 row for type 1
 *   (invisible).  LabFormType 12 has Discipline ''.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPath = require('path');

const libBookstoreSeed = require('./Bookstore-Seed.js');
const libCommon = require('./Domain-Seed-Common.js');

const FIXTURE = 'LabTrack';

const MODEL_PATH = libPath.resolve(__dirname, 'LabTrack-Model.json');

const DEFINITIONS_PATH = libPath.resolve(__dirname, 'LabTrack-Definitions.json');

const DEFAULT_SEED = 20261008;

const TENANT_COLUMN = 'IDCustomer';

const SCALES = { Small: 1, Medium: 4 };

// The pinned request clock every in-process test uses (internal-contracts §31.3).
const TEST_NOW = '2026-10-08T12:00:00Z';

// The RetoldFaceting options the harness applies for this domain (internal-contracts §31.2):
// tenancy on IDCustomer, LabForm additionally owner-scoped (OwnerIDUser = the session's UserID).
const FACETING_OPTIONS = Object.freeze(
	{
		Scope:
			{
				Policy:
					{
						Column: 'IDCustomer',
						SessionField: 'CustomerID',
						Exclude: [ 'LabFormType' ],
						PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' } }
					},
				Guard: 'Strict'
			},
		Catalog: { GlobalEntities: [ 'LabFormType' ] },
		Definitions: { Path: false, Files: [ DEFINITIONS_PATH ] }
	});

// Parents first.
const GENERATION_ORDER = Object.freeze([ 'Customer', 'User', 'LabQueue', 'LabQueueMember', 'MaterialType', 'MaterialIntake', 'LabFormType', 'MaterialIntakeRequirement', 'MaterialTypeFormRequirement', 'LabForm' ]);

// Small sizes per tenant (Medium ×4); story rows are part of these totals.
const BASE_SIZES = Object.freeze(
	{
		User: [ 30, 6 ],
		LabQueue: [ 6, 2 ],
		LabQueueMember: [ 40, 8 ],
		MaterialType: [ 8, 2 ],
		MaterialIntake: [ 300, 60 ],
		MaterialTypeFormRequirement: [ 40, 8 ],
		LabForm: [ 700, 110 ]
	});

const LAB_FORM_TYPE_COUNT = 12;

const TECH = 1;
const COLLEAGUE = 2;
const NEWBIE = 3;

const TECH_QUEUE_IDS = Object.freeze([ 1, 2 ]);
const TECH_INACTIVE_QUEUE_ID = 3;
const TECH_DELETED_MEMBERSHIP_QUEUE_ID = 4;
const DELETED_QUEUE_ID = 5;
const COLLEAGUE_ONLY_QUEUE_ID = 6;
const DELETED_INTAKE_ID = 1;
const DUPLICATE_TYPE_REQUIREMENT = Object.freeze({ IDMaterialType: 1, IDLabFormType: 2 });

// The forms every case writes (internal story; see the header).
const CASE_COUNT = 8;

const DISCIPLINES = [ 'Chemistry', 'Biology', 'Physics', 'Materials' ];
const QUEUE_NAMES = [ 'Receiving', 'Wet Lab', 'Spectroscopy', 'Metallurgy', 'Archive', 'Microbiology' ];
const MATERIAL_NAMES = [ 'Soil', 'Water', 'Alloy', 'Polymer', 'Tissue', 'Resin', 'Ceramic', 'Glass' ];
const FIRST_NAMES = [ 'Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Frances', 'Ken', 'Radia', 'Tim', 'Margaret', 'John' ];
const LAST_NAMES = [ 'Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Knuth', 'Allen', 'Thompson', 'Perlman', 'Berners-Lee', 'Hamilton', 'Backus' ];

const INTAKE_STATUS_WEIGHTS = [ [ 'Received', 35 ], [ 'InProgress', 30 ], [ 'Complete', 30 ], [ '', 5 ] ];
const PRIORITY_WEIGHTS = [ [ 'High', 20 ], [ 'Normal', 60 ], [ 'Low', 15 ], [ '', 5 ] ];
const FORM_STATUS_WEIGHTS = [ [ 'Complete', 50 ], [ 'Pending', 30 ], [ 'Rejected', 10 ], [ '', 5 ], [ null, 5 ] ];

// ReceivedDate window: 38 ISO weeks of 2026 (Mondays 2026-01-05 … 2026-09-28).
const RECEIVED_LO = libCommon.epoch(2026, 1, 5);
const RECEIVED_HI = libCommon.epoch(2026, 10, 5);

/**
 * @return {Record<string, any>} a deep clone of the domain model
 */
const model = () =>
{
	return JSON.parse(JSON.stringify(require(MODEL_PATH)));
};

/**
 * Generate the deterministic rows (no database).
 *
 * @param {{ Seed?: number, Scale?: string }} [pOptions]
 * @return {Record<string, any>}
 */
const generate = (pOptions) =>
{
	let tmpResolved = libCommon.resolveOptions(pOptions, DEFAULT_SEED, SCALES);
	let tmpSeed = tmpResolved.Seed;
	let tmpMultiplier = tmpResolved.Multiplier;
	let tmpModel = model();
	let fSize = (pTable, pTenantIndex) => { return BASE_SIZES[pTable][pTenantIndex] * tmpMultiplier; };
	let fStream = (pName) => { return libCommon.stream(tmpSeed, `${FIXTURE}.${pName}`); };

	let tmpRows = {};
	GENERATION_ORDER.forEach((pTable) => { tmpRows[pTable] = []; });

	// ---------------------------------------------------------------- id plan (tenant 1 first)
	let tmpUsers1 = libCommon.range(1, fSize('User', 0));
	let tmpUsers2 = libCommon.range(tmpUsers1.length + 1, tmpUsers1.length + fSize('User', 1));
	let tmpOtherTech = tmpUsers2[0];
	let tmpOthers1 = tmpUsers1.filter((pID) => { return (pID > NEWBIE) && (pID < tmpUsers1[tmpUsers1.length - 1]); });
	let tmpOthers2 = tmpUsers2.filter((pID) => { return (pID !== tmpOtherTech) && (pID < tmpUsers2[tmpUsers2.length - 1]); });

	let tmpQueues1 = libCommon.range(1, fSize('LabQueue', 0));
	let tmpQueues2 = libCommon.range(tmpQueues1.length + 1, tmpQueues1.length + fSize('LabQueue', 1));
	let tmpTypes1 = libCommon.range(1, fSize('MaterialType', 0));
	let tmpTypes2 = libCommon.range(tmpTypes1.length + 1, tmpTypes1.length + fSize('MaterialType', 1));
	let tmpIntakes1 = libCommon.range(1, fSize('MaterialIntake', 0));
	let tmpIntakes2 = libCommon.range(tmpIntakes1.length + 1, tmpIntakes1.length + fSize('MaterialIntake', 1));
	let tmpFormTypes = libCommon.range(1, LAB_FORM_TYPE_COUNT);
	let fUsers = (pTenant) => { return (pTenant === 1) ? tmpUsers1 : tmpUsers2; };

	// ---------------------------------------------------------------- Customer
	let tmpRandom = fStream('Customer');
	tmpRows.Customer.push(libCommon.audit({ IDCustomer: 1, GUIDCustomer: libCommon.guid(tmpRandom), Name: 'Northwind Labs' }, tmpRandom, [ TECH ], false));
	tmpRows.Customer.push(libCommon.audit({ IDCustomer: 2, GUIDCustomer: libCommon.guid(tmpRandom), Name: 'Southwind Labs' }, tmpRandom, [ tmpOtherTech ], false));

	// ---------------------------------------------------------------- User
	tmpRandom = fStream('User');
	let fUser = (pID, pTenant, pDeleted) =>
	{
		let tmpRow = { IDUser: pID, GUIDUser: libCommon.guid(tmpRandom), LoginID: `tech${pID}`, NameFirst: tmpRandom.pick(FIRST_NAMES), NameLast: tmpRandom.pick(LAST_NAMES), IDCustomer: pTenant };
		return libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted);
	};
	tmpUsers1.forEach((pID, pIndex) => { tmpRows.User.push(fUser(pID, 1, pIndex === tmpUsers1.length - 1)); });
	tmpUsers2.forEach((pID, pIndex) => { tmpRows.User.push(fUser(pID, 2, pIndex === tmpUsers2.length - 1)); });
	tmpRows.User[0].NameFirst = 'Tess';
	tmpRows.User[0].NameLast = 'Tech';
	tmpRows.User[1].NameFirst = 'Cole';
	tmpRows.User[1].NameLast = 'Colleague';
	tmpRows.User[2].NameFirst = 'Nia';
	tmpRows.User[2].NameLast = 'Newbie';

	// ---------------------------------------------------------------- LabQueue
	tmpRandom = fStream('LabQueue');
	tmpQueues1.forEach(
		(pID, pIndex) =>
		{
			let tmpName = QUEUE_NAMES[pIndex % QUEUE_NAMES.length] + ((pIndex >= QUEUE_NAMES.length) ? ` ${Math.floor(pIndex / QUEUE_NAMES.length) + 1}` : '');
			tmpRows.LabQueue.push(libCommon.audit({ IDLabQueue: pID, GUIDLabQueue: libCommon.guid(tmpRandom), Name: tmpName, IDCustomer: 1 }, tmpRandom, tmpUsers1, pID === DELETED_QUEUE_ID));
		});
	tmpQueues2.forEach(
		(pID, pIndex) =>
		{
			tmpRows.LabQueue.push(libCommon.audit({ IDLabQueue: pID, GUIDLabQueue: libCommon.guid(tmpRandom), Name: `South ${QUEUE_NAMES[pIndex % QUEUE_NAMES.length]}`, IDCustomer: 2 }, tmpRandom, tmpUsers2, pIndex === tmpQueues2.length - 1));
		});

	// ---------------------------------------------------------------- LabQueueMember
	tmpRandom = fStream('LabQueueMember');
	let tmpMemberID = 0;
	let tmpMemberPairs = new Set();
	let fMember = (pTenant, pQueue, pUser, pActive, pDeleted) =>
	{
		tmpMemberID++;
		tmpMemberPairs.add(`${pQueue}|${pUser}`);
		let tmpRow = { IDLabQueueMember: tmpMemberID, GUIDLabQueueMember: libCommon.guid(tmpRandom), IDLabQueue: pQueue, IDUser: pUser, Active: pActive, IDCustomer: pTenant };
		tmpRows.LabQueueMember.push(libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted));
	};
	fMember(1, TECH_QUEUE_IDS[0], TECH, 1, false);
	fMember(1, TECH_QUEUE_IDS[1], TECH, 1, false);
	fMember(1, TECH_INACTIVE_QUEUE_ID, TECH, 0, false);
	fMember(1, TECH_DELETED_MEMBERSHIP_QUEUE_ID, TECH, 1, true);
	fMember(1, DELETED_QUEUE_ID, TECH, 1, false);
	fMember(1, TECH_QUEUE_IDS[0], COLLEAGUE, 1, false);
	fMember(1, COLLEAGUE_ONLY_QUEUE_ID, COLLEAGUE, 1, false);
	let tmpMemberTarget1 = fSize('LabQueueMember', 0);
	let tmpGuard = 0;
	while ((tmpRows.LabQueueMember.length < tmpMemberTarget1) && (tmpGuard++ < tmpMemberTarget1 * 50))
	{
		let tmpQueue = tmpRandom.pick(tmpQueues1);
		let tmpUser = tmpRandom.pick(tmpOthers1);
		if (tmpMemberPairs.has(`${tmpQueue}|${tmpUser}`))
		{
			continue;
		}
		fMember(1, tmpQueue, tmpUser, tmpRandom.chance(0.85) ? 1 : 0);
	}
	// Tenant 2: OtherTech, a cross-tenant row (a tenant-2 membership of Tech in tenant-1 queue 6), filler
	fMember(2, tmpQueues2[0], tmpOtherTech, 1, false);
	fMember(2, COLLEAGUE_ONLY_QUEUE_ID, TECH, 1, false);
	let tmpMemberTarget2 = tmpMemberTarget1 + fSize('LabQueueMember', 1);
	tmpGuard = 0;
	while ((tmpRows.LabQueueMember.length < tmpMemberTarget2) && (tmpGuard++ < tmpMemberTarget2 * 50))
	{
		let tmpQueue = tmpRandom.pick(tmpQueues2);
		let tmpUser = tmpRandom.pick(tmpOthers2);
		if (tmpMemberPairs.has(`${tmpQueue}|${tmpUser}`))
		{
			continue;
		}
		fMember(2, tmpQueue, tmpUser, tmpRandom.chance(0.85) ? 1 : 0);
	}

	// ---------------------------------------------------------------- MaterialType
	tmpRandom = fStream('MaterialType');
	tmpTypes1.forEach(
		(pID, pIndex) =>
		{
			tmpRows.MaterialType.push(libCommon.audit({ IDMaterialType: pID, GUIDMaterialType: libCommon.guid(tmpRandom), Name: MATERIAL_NAMES[pIndex % MATERIAL_NAMES.length] + ((pIndex >= MATERIAL_NAMES.length) ? ` ${Math.floor(pIndex / MATERIAL_NAMES.length) + 1}` : ''), IDCustomer: 1 }, tmpRandom, tmpUsers1, pIndex === tmpTypes1.length - 1));
		});
	tmpTypes2.forEach(
		(pID, pIndex) =>
		{
			tmpRows.MaterialType.push(libCommon.audit({ IDMaterialType: pID, GUIDMaterialType: libCommon.guid(tmpRandom), Name: `South ${MATERIAL_NAMES[pIndex % MATERIAL_NAMES.length]}`, IDCustomer: 2 }, tmpRandom, tmpUsers2, pIndex === tmpTypes2.length - 1));
		});

	// ---------------------------------------------------------------- MaterialIntake
	tmpRandom = fStream('MaterialIntake');
	let fIntake = (pID, pTenant, pFields, pDeleted) =>
	{
		let tmpRow = Object.assign(
			{
				IDMaterialIntake: pID,
				GUIDMaterialIntake: libCommon.guid(tmpRandom),
				ReceivedDate: tmpRandom.chance(0.04) ? null : libCommon.randomDate(tmpRandom, RECEIVED_LO, RECEIVED_HI),
				Status: tmpRandom.weighted(INTAKE_STATUS_WEIGHTS),
				Priority: tmpRandom.weighted(PRIORITY_WEIGHTS),
				IDLabQueue: null,
				IDMaterialType: null,
				AssignedIDUser: tmpRandom.chance(0.1) ? null : tmpRandom.pick((pTenant === 1) ? tmpUsers1.slice(0, -1) : tmpUsers2.slice(0, -1)),
				IDCustomer: pTenant
			}, pFields);
		return libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted);
	};
	let tmpQueueWeights1 = tmpQueues1.map((pID) => { return [ pID, (pID === 1) ? 25 : ((pID === 2) ? 20 : 8) ]; });
	tmpQueueWeights1.push([ null, 4 ]);
	tmpQueueWeights1.push([ tmpQueues2[0], 1 ]);
	let tmpTypeWeights1 = tmpTypes1.map((pID) => { return [ pID, 10 ]; });
	tmpTypeWeights1.push([ null, 3 ]);
	tmpIntakes1.forEach(
		(pID) =>
		{
			let tmpFields;
			let tmpDeleted;
			switch (pID)
			{
				case DELETED_INTAKE_ID:
					tmpFields = { IDLabQueue: 1, IDMaterialType: 1, Status: 'Received', ReceivedDate: '2026-03-02 09:00:00' };
					tmpDeleted = true;
					break;
				case 2:
					tmpFields = { IDLabQueue: DELETED_QUEUE_ID, IDMaterialType: 1, Status: 'Received', ReceivedDate: '2026-03-03 09:00:00' };
					tmpDeleted = false;
					break;
				case 3:
					tmpFields = { IDLabQueue: null, IDMaterialType: 1, Status: 'Received', ReceivedDate: '2026-03-04 09:00:00' };
					tmpDeleted = false;
					break;
				case 4:
					tmpFields = { IDLabQueue: tmpQueues2[0], IDMaterialType: 1, Status: 'Received', ReceivedDate: '2026-03-05 09:00:00' };
					tmpDeleted = false;
					break;
				case 5:
					tmpFields = { IDLabQueue: 1, IDMaterialType: 1, Status: '', ReceivedDate: '2026-03-06 09:00:00' };
					tmpDeleted = false;
					break;
				case 6:
					tmpFields = { IDLabQueue: 1, IDMaterialType: 1, Status: 'Complete', ReceivedDate: '2026-03-07 09:00:00' };
					tmpDeleted = false;
					break;
				case 7:
					tmpFields = { IDLabQueue: 2, IDMaterialType: 1, Status: 'InProgress', ReceivedDate: null };
					tmpDeleted = false;
					break;
				case 8:
					// ISO week edges: Sunday night (week of 2025-12-29), Monday midnight, a year-end day
					tmpFields = { IDLabQueue: 1, IDMaterialType: 1, Status: 'Received', ReceivedDate: '2026-01-04 23:59:59' };
					tmpDeleted = false;
					break;
				case 9:
					tmpFields = { IDLabQueue: 2, IDMaterialType: 2, Status: 'Received', ReceivedDate: '2026-01-05 00:00:00' };
					tmpDeleted = false;
					break;
				case 10:
					tmpFields = { IDLabQueue: 1, IDMaterialType: 2, Status: 'InProgress', ReceivedDate: '2025-12-31 12:00:00' };
					tmpDeleted = false;
					break;
				case 11:
					tmpFields = { IDLabQueue: 6, IDMaterialType: 2, Status: 'Received', ReceivedDate: '2026-04-01 10:00:00' };
					tmpDeleted = false;
					break;
				default:
					tmpFields = { IDLabQueue: tmpRandom.weighted(tmpQueueWeights1), IDMaterialType: tmpRandom.weighted(tmpTypeWeights1) };
					tmpDeleted = undefined;
			}
			tmpRows.MaterialIntake.push(fIntake(pID, 1, tmpFields, tmpDeleted));
		});
	tmpIntakes2.forEach(
		(pID, pIndex) =>
		{
			// A tenant-2 intake in tenant-1 queue 1 (cross-tenant), else tenant-2 queues
			let tmpQueue = (pIndex === 0) ? 1 : tmpRandom.pick(tmpQueues2);
			tmpRows.MaterialIntake.push(fIntake(pID, 2, { IDLabQueue: tmpQueue, IDMaterialType: tmpRandom.pick(tmpTypes2) }, (pIndex === 1) ? true : undefined));
		});

	// ---------------------------------------------------------------- LabFormType (global lookup)
	tmpRandom = fStream('LabFormType');
	tmpFormTypes.forEach(
		(pID) =>
		{
			tmpRows.LabFormType.push({ IDLabFormType: pID, GUIDLabFormType: libCommon.guid(tmpRandom), Name: `Lab Form ${String.fromCharCode(64 + pID)}`, Discipline: (pID === LAB_FORM_TYPE_COUNT) ? '' : DISCIPLINES[pID % DISCIPLINES.length] });
		});

	// ---------------------------------------------------------------- MaterialTypeFormRequirement
	tmpRandom = fStream('MaterialTypeFormRequirement');
	let tmpTypeRequirementID = 0;
	let fTypeRequirement = (pTenant, pType, pForm, pRequired, pDeleted) =>
	{
		tmpTypeRequirementID++;
		let tmpRow = { IDMaterialTypeFormRequirement: tmpTypeRequirementID, GUIDMaterialTypeFormRequirement: libCommon.guid(tmpRandom), IDMaterialType: pType, IDLabFormType: pForm, Required: pRequired, IDCustomer: pTenant };
		tmpRows.MaterialTypeFormRequirement.push(libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted));
	};
	// Type 1: the explicit story (a duplicate (type, form) row, a Required 0 row, a soft-deleted row)
	fTypeRequirement(1, 1, 1, 1, false);
	fTypeRequirement(1, 1, DUPLICATE_TYPE_REQUIREMENT.IDLabFormType, 1, false);
	fTypeRequirement(1, 1, DUPLICATE_TYPE_REQUIREMENT.IDLabFormType, 1, false);
	fTypeRequirement(1, 1, 3, 0, false);
	fTypeRequirement(1, 1, 5, 1, true);
	tmpTypes1.slice(1).forEach(
		(pType) =>
		{
			let tmpForms = tmpFormTypes.slice();
			for (let i = 0; i < 5; i++)
			{
				let tmpForm = tmpForms.splice(Math.floor(tmpRandom.next() * tmpForms.length), 1)[0];
				fTypeRequirement(1, pType, tmpForm, tmpRandom.chance(0.7) ? 1 : 0);
			}
		});
	while (tmpRows.MaterialTypeFormRequirement.length < fSize('MaterialTypeFormRequirement', 0))
	{
		fTypeRequirement(1, tmpRandom.pick(tmpTypes1), tmpRandom.pick(tmpFormTypes), tmpRandom.chance(0.7) ? 1 : 0);
	}
	let tmpTypeRequirementTarget2 = tmpRows.MaterialTypeFormRequirement.length + fSize('MaterialTypeFormRequirement', 1);
	// Tenant 2: a row for tenant-1 type 1 (invisible), then its own types
	fTypeRequirement(2, 1, 4, 1, false);
	while (tmpRows.MaterialTypeFormRequirement.length < tmpTypeRequirementTarget2)
	{
		fTypeRequirement(2, tmpRandom.pick(tmpTypes2), tmpRandom.pick(tmpFormTypes), tmpRandom.chance(0.7) ? 1 : 0, (tmpRows.MaterialTypeFormRequirement.length === tmpTypeRequirementTarget2 - 1) ? true : undefined);
	}

	// ---------------------------------------------------------------- MaterialIntakeRequirement
	tmpRandom = fStream('MaterialIntakeRequirement');
	let tmpRequiredForms = new Map();
	tmpRows.MaterialTypeFormRequirement.forEach(
		(pRow) =>
		{
			if ((pRow.Required === 1) && (pRow.Deleted === 0))
			{
				let tmpKey = `${pRow.IDCustomer}|${pRow.IDMaterialType}`;
				if (!tmpRequiredForms.has(tmpKey))
				{
					tmpRequiredForms.set(tmpKey, []);
				}
				if (tmpRequiredForms.get(tmpKey).indexOf(pRow.IDLabFormType) < 0)
				{
					tmpRequiredForms.get(tmpKey).push(pRow.IDLabFormType);
				}
			}
		});
	let tmpRequirementID = 0;
	let fRequirement = (pTenant, pIntake, pForm, pDeleted) =>
	{
		tmpRequirementID++;
		let tmpRow = { IDMaterialIntakeRequirement: tmpRequirementID, GUIDMaterialIntakeRequirement: libCommon.guid(tmpRandom), IDMaterialIntake: pIntake, IDLabFormType: pForm, IDCustomer: pTenant };
		tmpRows.MaterialIntakeRequirement.push(libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted));
	};
	tmpRows.MaterialIntake.forEach(
		(pIntake) =>
		{
			let tmpForms = (tmpRequiredForms.get(`${pIntake.IDCustomer}|${pIntake.IDMaterialType}`) || []).slice();
			while (tmpForms.length < 3)
			{
				let tmpExtra = tmpRandom.pick(tmpFormTypes);
				if (tmpForms.indexOf(tmpExtra) < 0)
				{
					tmpForms.push(tmpExtra);
				}
			}
			tmpForms.forEach((pForm) => { fRequirement(pIntake.IDCustomer, pIntake.IDMaterialIntake, pForm, (pIntake.IDMaterialIntake === DELETED_INTAKE_ID) ? false : undefined); });
		});
	// Tenant 2: a requirement on tenant-1 intake 12 (cross-tenant, invisible)
	fRequirement(2, 12, 1, false);

	// ---------------------------------------------------------------- LabForm
	tmpRandom = fStream('LabForm');
	let tmpFormID = 0;
	let fForm = (pTenant, pIntake, pForm, pOwner, pStatus, pDeleted) =>
	{
		tmpFormID++;
		let tmpRow =
			{
				IDLabForm: tmpFormID,
				GUIDLabForm: libCommon.guid(tmpRandom),
				IDMaterialIntake: pIntake,
				IDLabFormType: pForm,
				Status: pStatus,
				CompletedDate: (pStatus === 'Complete') ? libCommon.randomDate(tmpRandom, RECEIVED_LO, RECEIVED_HI) : null,
				OwnerIDUser: pOwner,
				IDCustomer: pTenant
			};
		tmpRows.LabForm.push(libCommon.audit(tmpRow, tmpRandom, fUsers(pTenant), pDeleted));
	};
	let tmpIntakeByID = new Map(tmpRows.MaterialIntake.map((pIntake) => { return [ pIntake.IDMaterialIntake, pIntake ]; }));
	let tmpColleagueCompleted = [];
	let tmpStoryCase = 0;
	let tmpStoryRequirements = new Set();
	tmpRows.MaterialIntakeRequirement.forEach(
		(pRequirement) =>
		{
			let tmpIntake = tmpIntakeByID.get(pRequirement.IDMaterialIntake);
			if ((pRequirement.IDCustomer !== 1) || !tmpIntake || (tmpIntake.IDCustomer !== 1) || (TECH_QUEUE_IDS.indexOf(tmpIntake.IDLabQueue) < 0))
			{
				return;
			}
			let tmpPair = `${pRequirement.IDMaterialIntake}|${pRequirement.IDLabFormType}`;
			if (tmpStoryRequirements.has(tmpPair))
			{
				return;
			}
			tmpStoryRequirements.add(tmpPair);
			let tmpIntakeID = pRequirement.IDMaterialIntake;
			let tmpFormType = pRequirement.IDLabFormType;
			switch (tmpStoryCase % CASE_COUNT)
			{
				case 0:
					break;
				case 1:
					fForm(1, tmpIntakeID, tmpFormType, TECH, 'Pending', false);
					break;
				case 2:
					fForm(1, tmpIntakeID, tmpFormType, TECH, 'Complete', false);
					break;
				case 3:
					fForm(1, tmpIntakeID, tmpFormType, COLLEAGUE, 'Complete', false);
					tmpColleagueCompleted.push({ IDMaterialIntake: tmpIntakeID, IDLabFormType: tmpFormType });
					break;
				case 4:
					fForm(1, tmpIntakeID, tmpFormType, TECH, 'Complete', true);
					break;
				case 5:
					fForm(2, tmpIntakeID, tmpFormType, tmpOtherTech, 'Complete', false);
					break;
				case 6:
					fForm(1, tmpIntakeID, tmpFormType, COLLEAGUE, 'Pending', false);
					fForm(1, tmpIntakeID, tmpFormType, TECH, null, false);
					break;
				case 7:
					fForm(1, tmpIntakeID, tmpFormType, TECH, 'Pending', false);
					fForm(1, tmpIntakeID, tmpFormType, NEWBIE, 'Complete', false);
					break;
			}
			tmpStoryCase++;
		});
	// Filler: forms on the other tenant-1 requirements (never on a story pair), then strays
	let tmpOtherRequirements = tmpRows.MaterialIntakeRequirement.filter(
		(pRequirement) =>
		{
			return (pRequirement.IDCustomer === 1) && !tmpStoryRequirements.has(`${pRequirement.IDMaterialIntake}|${pRequirement.IDLabFormType}`)
				&& tmpIntakeByID.has(pRequirement.IDMaterialIntake) && (tmpIntakeByID.get(pRequirement.IDMaterialIntake).IDCustomer === 1)
				&& (TECH_QUEUE_IDS.indexOf(tmpIntakeByID.get(pRequirement.IDMaterialIntake).IDLabQueue) < 0);
		});
	let tmpFormTarget1 = fSize('LabForm', 0);
	let tmpFormOwners1 = tmpOthers1.concat([ COLLEAGUE, COLLEAGUE, NEWBIE ]);
	for (let i = 0; (i < tmpOtherRequirements.length) && (tmpRows.LabForm.length < tmpFormTarget1); i++)
	{
		if (tmpRandom.chance(0.45))
		{
			let tmpRequirement = tmpOtherRequirements[i];
			fForm(1, tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, tmpRandom.pick(tmpFormOwners1), tmpRandom.weighted(FORM_STATUS_WEIGHTS));
		}
	}
	let tmpNonStoryIntakes1 = tmpRows.MaterialIntake.filter((pIntake) => { return (pIntake.IDCustomer === 1) && (TECH_QUEUE_IDS.indexOf(pIntake.IDLabQueue) < 0); }).map((pIntake) => { return pIntake.IDMaterialIntake; });
	while (tmpRows.LabForm.filter((pForm) => { return pForm.IDCustomer === 1; }).length < tmpFormTarget1)
	{
		fForm(1, tmpRandom.chance(0.03) ? null : tmpRandom.pick(tmpNonStoryIntakes1), tmpRandom.pick(tmpFormTypes), tmpRandom.pick(tmpFormOwners1), tmpRandom.weighted(FORM_STATUS_WEIGHTS));
	}
	// Tenant 2 filler (OtherTech and its colleagues) on tenant-2 requirements
	let tmpRequirements2 = tmpRows.MaterialIntakeRequirement.filter((pRequirement) => { return (pRequirement.IDCustomer === 2) && (pRequirement.IDMaterialIntake > tmpIntakes1.length); });
	let tmpFormTarget2 = fSize('LabForm', 1);
	tmpGuard = 0;
	while ((tmpRows.LabForm.filter((pForm) => { return pForm.IDCustomer === 2; }).length < tmpFormTarget2) && (tmpGuard++ < tmpFormTarget2 * 20))
	{
		let tmpRequirement = tmpRandom.pick(tmpRequirements2);
		fForm(2, tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, tmpRandom.chance(0.4) ? tmpOtherTech : tmpRandom.pick(tmpOthers2), tmpRandom.weighted(FORM_STATUS_WEIGHTS));
	}

	// Every soft-deletable table: at least one deleted row per tenant (Customer excepted).
	let tmpDeletedFix = fStream('DeletedFix');
	[ 'User', 'LabQueue', 'LabQueueMember', 'MaterialType', 'MaterialIntake', 'MaterialIntakeRequirement', 'MaterialTypeFormRequirement', 'LabForm' ].forEach(
		(pTable) =>
		{
			[ 1, 2 ].forEach(
				(pTenant) =>
				{
					let tmpTenantRows = tmpRows[pTable].filter((pRow) => { return pRow.IDCustomer === pTenant; });
					if (!tmpTenantRows.some((pRow) => { return pRow.Deleted === 1; }))
					{
						libCommon.softDelete(tmpDeletedFix.pick(tmpTenantRows.slice(Math.floor(tmpTenantRows.length / 2))));
					}
				});
		});

	libCommon.completeRows(tmpModel, tmpRows);

	return (
		{
			Fixture: FIXTURE,
			Seed: tmpSeed,
			Scale: tmpResolved.Scale,
			Model: tmpModel,
			Rows: tmpRows,
			Order: GENERATION_ORDER.slice(),
			Tenants: [ 1, 2 ],
			TenantColumn: TENANT_COLUMN,
			Traps:
				{
					TechQueueIDs: TECH_QUEUE_IDS.slice(),
					TechInactiveQueueID: TECH_INACTIVE_QUEUE_ID,
					TechDeletedMembershipQueueID: TECH_DELETED_MEMBERSHIP_QUEUE_ID,
					DeletedQueueID: DELETED_QUEUE_ID,
					ColleagueOnlyQueueID: COLLEAGUE_ONLY_QUEUE_ID,
					CrossTenantQueueID: tmpQueues2[0],
					DeletedIntakeID: DELETED_INTAKE_ID,
					DuplicateTypeRequirement: Object.assign({}, DUPLICATE_TYPE_REQUIREMENT),
					ColleagueCompleted: tmpColleagueCompleted,
					StoryCaseCount: CASE_COUNT,
					BlankDisciplineLabFormTypeID: LAB_FORM_TYPE_COUNT,
					TestNow: TEST_NOW
				},
			Principals:
				{
					Tech: { Tenant: 1, User: TECH, Note: 'Active in queues 1 and 2, inactive in 3, soft-deleted membership in 4, active in the soft-deleted queue 5.' },
					Colleague: { Tenant: 1, User: COLLEAGUE, Note: 'Active in queue 1 (shared with Tech) and 6.' },
					Newbie: { Tenant: 1, User: NEWBIE, Note: 'In no queue.' },
					OtherTech: { Tenant: 2, User: tmpOtherTech, Note: 'Tenant 2\'s technician.' }
				}
		});
};

/**
 * Create the tables in a node:sqlite database and insert the generated rows.
 *
 * @param {any} pDB
 * @param {{ Seed?: number, Scale?: string }} [pOptions]
 * @return {Record<string, any>}
 */
const build = (pDB, pOptions) =>
{
	return libCommon.buildFromGenerated(pDB, generate(pOptions));
};

module.exports = (
	{
		FIXTURE: FIXTURE,
		MODEL_PATH: MODEL_PATH,
		DEFINITIONS_PATH: DEFINITIONS_PATH,
		DEFAULT_SEED: DEFAULT_SEED,
		TENANT_COLUMN: TENANT_COLUMN,
		SCALES: SCALES,
		TEST_NOW: TEST_NOW,
		GENERATION_ORDER: GENERATION_ORDER,
		FACETING_OPTIONS: FACETING_OPTIONS,
		prng: libBookstoreSeed.prng,
		createTables: libBookstoreSeed.createTables,
		model: model,
		generate: generate,
		build: build
	});
