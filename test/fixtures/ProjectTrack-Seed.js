/**
 * ProjectTrack-Seed — deterministic fixture generator for the ProjectTrack domain (design 08 §1,
 * E1 and E2; internal-contracts §31).
 *
 * Tables (test/fixtures/ProjectTrack-Model.json, standard audit columns + Deleted unless noted):
 *   Customer (tenant root), User, Client, Project, ProjectMembership, Task, Issue,
 *   FormType (global lookup: no Deleted, no IDCustomer), Document.
 * Tenancy column IDCustomer; two tenants (1 and 2); FormType is a global lookup opted in through
 * Catalog.GlobalEntities.
 *
 * Same API as Bookstore-Seed (internal-contracts §31.6):
 *   model()                       → deep clone of ProjectTrack-Model.json
 *   generate({ Seed, Scale })     → { Fixture, Seed, Scale, Model, Rows, Order, Tenants, TenantColumn, Traps, Principals }
 *   build(pDB, { Seed, Scale })   → generate + createTables + insert (SQLite) → counts + Traps + Principals (+ Rows)
 *
 * The data is a STORY plus deterministic filler.  The story rows (fixed IDs, the same at every
 * Scale) make every E1 / E2 edge observable:
 *
 *   Lead (tenant 1, user 1) — projects 1…19:
 *     Owner / Lead memberships (one inactive: 7, one soft-deleted: 8), ownership without a
 *     membership (3, 9, 12), with both (4, 14), a soft-deleted project (17);
 *     overdue tasks assigned to Lead spread over bands 0 (9), 1–2, 3–9 (2, 5, 10) and 10+ (3, 14),
 *     with noise that must never count (Done, Status NULL, soft-deleted, future, NULL DueDate, and
 *     a tenant-2 task on tenant-1 project 1);
 *     open Blocker on 6 (blocked), closed Blocker on 2, open non-Blocker on 3, SOFT-DELETED open
 *     Blocker on 4 (must not block), a tenant-2 open Blocker on 5 (invisible: must not block);
 *     E1 lands on 1, 2, 3, 4, 5, 16 (plus whatever the filler adds); each disjunctive facet gains
 *     one witness of its own: Status (10, OnHold), Client (12 → soft-deleted client, 18 →
 *     tenant-2 client: unlabelled keys), Started (11 on 2025-12-31 23:59:59, 19 with NULL).
 *   Every $Now-compared date (Task.DueDate) is ≤ 2025-12-31 23:59:59, ≥ 2031-01-01 00:00:00 or
 *   NULL, so any clock in 2026–2030 (and the pinned TestNow) gives identical answers.
 *   Tenant 2 has its own users, clients, projects (OtherLead = its Lead), a T2-only Project.Status
 *   'Cancelled' and Document.Status 'Withdrawn' (they must never show for tenant 1), and
 *   cross-tenant references both ways (they must land in Missing / fail existence).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPath = require('path');

const libBookstoreSeed = require('./Bookstore-Seed.js');
const libCommon = require('./Domain-Seed-Common.js');

const FIXTURE = 'ProjectTrack';

const MODEL_PATH = libPath.resolve(__dirname, 'ProjectTrack-Model.json');

const DEFINITIONS_PATH = libPath.resolve(__dirname, 'ProjectTrack-Definitions.json');

const DEFAULT_SEED = 20261008;

const TENANT_COLUMN = 'IDCustomer';

// Row-count multiplier per scale (same names as the bookstore).
const SCALES = { Small: 1, Medium: 4 };

// The pinned request clock every in-process test uses (internal-contracts §31.3).
const TEST_NOW = '2026-10-08T12:00:00Z';

// The RetoldFaceting options the harness applies for this domain (internal-contracts §31.2).
const FACETING_OPTIONS = Object.freeze(
	{
		Scope:
			{
				Policy: { Column: 'IDCustomer', SessionField: 'CustomerID', Exclude: [ 'FormType' ], PersonalScopes: {} },
				Guard: 'Strict'
			},
		Catalog: { GlobalEntities: [ 'FormType' ] },
		Definitions: { Path: false, Files: [ DEFINITIONS_PATH ] }
	});

// Parents first.
const GENERATION_ORDER = Object.freeze([ 'Customer', 'User', 'Client', 'Project', 'ProjectMembership', 'Task', 'Issue', 'FormType', 'Document' ]);

// Small sizes per tenant (Medium ×4); the story rows are part of these totals.
const BASE_SIZES = Object.freeze(
	{
		User: [ 30, 6 ],
		Client: [ 12, 3 ],
		Project: [ 60, 12 ],
		ProjectMembership: [ 200, 32 ],
		Task: [ 600, 96 ],
		Issue: [ 150, 24 ],
		Document: [ 800, 128 ]
	});

const FORM_TYPE_COUNT = 12;

// Fixed trap values (the same at every Scale).
const E1_CLIENT_IDS = Object.freeze([ 3, 9 ]);
const E2_FORM_TYPE_ID = 4;
const DANGLING_FORM_TYPE_ID = 99;
const DELETED_PROJECT_ID = 17;
const STORY_PROJECT_COUNT = 19;

// Principals (user IDs in tenant 1; OtherLead is tenant 2's first user).
const LEAD = 1;
const MEMBER = 2;
const OUTSIDER = 3;

// Windows of the $Now-compared Task.DueDate (never near any plausible clock).
const PAST_LO = libCommon.epoch(2024, 1, 1);
const PAST_HI = libCommon.epoch(2026, 1, 1);
const FUTURE_LO = libCommon.epoch(2031, 1, 1);
const FUTURE_HI = libCommon.epoch(2033, 1, 1);
const PAST_EDGE = '2025-12-31 23:59:59';
const FUTURE_EDGE = '2031-01-01 00:00:00';

const CLIENT_NAMES = [ 'Acme Labs', 'Borealis', 'Cobalt Works', 'Delta Freight', 'Ember Health', 'Fjord Energy', 'Granite Bank', 'Harbor Foods', 'Iris Media', 'Juniper Air', 'Kestrel Law', 'Lumen Retail' ];
const FIRST_NAMES = [ 'Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Frances', 'Ken', 'Radia', 'Tim', 'Margaret', 'John' ];
const LAST_NAMES = [ 'Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Knuth', 'Allen', 'Thompson', 'Perlman', 'Berners-Lee', 'Hamilton', 'Backus' ];
const PROJECT_WORDS = [ 'Hangar', 'Atlas', 'Beacon', 'Cascade', 'Drift', 'Echo', 'Falcon', 'Garnet', 'Helix', 'Ion', 'Jetty', 'Keel' ];
const FORM_CATEGORIES = [ 'Safety', 'Quality', 'Finance', 'Legal' ];

const PROJECT_STATUS_WEIGHTS = [ [ 'Active', 40 ], [ 'AtRisk', 15 ], [ 'OnHold', 15 ], [ 'Done', 20 ], [ '', 6 ], [ null, 4 ] ];
const PROJECT_STATUS_WEIGHTS_T2 = [ [ 'Active', 40 ], [ 'AtRisk', 10 ], [ 'OnHold', 10 ], [ 'Done', 20 ], [ 'Cancelled', 15 ], [ '', 5 ] ];
const ROLE_WEIGHTS = [ [ 'Owner', 10 ], [ 'Lead', 15 ], [ 'Member', 55 ], [ 'Reviewer', 15 ], [ '', 5 ] ];
const TASK_STATUS_WEIGHTS = [ [ 'Open', 40 ], [ 'InProgress', 22 ], [ 'Done', 30 ], [ '', 4 ], [ null, 4 ] ];
const SEVERITY_WEIGHTS = [ [ 'Blocker', 15 ], [ 'Critical', 15 ], [ 'Major', 30 ], [ 'Minor', 35 ], [ '', 5 ] ];
const ISSUE_STATE_WEIGHTS = [ [ 'Open', 50 ], [ 'Closed', 45 ], [ '', 5 ] ];
const DOCUMENT_STATUS_WEIGHTS = [ [ 'Draft', 30 ], [ 'Final', 50 ], [ 'Archived', 15 ], [ '', 5 ] ];
const DOCUMENT_STATUS_WEIGHTS_T2 = [ [ 'Draft', 30 ], [ 'Final', 40 ], [ 'Withdrawn', 25 ], [ '', 5 ] ];

/**
 * Lead's story projects (tenant 1, IDs 1…19).  Client: a client ID, 'Deleted' (the soft-deleted
 * client), 'CrossTenant' (a tenant-2 client) or null.  Owner: a user ID ('Lead' = 1).  Lead: Lead's
 * membership { Role, Active, Deleted? } or null.  Overdue: open past-due tasks assigned to Lead.
 * Noise: Lead tasks that must never count as overdue.
 */
const LEAD_STORY = Object.freeze(
	[
		{ ID: 1, Status: 'Active', Start: '2026-02-10 09:00:00', Client: 3, Owner: 5, Lead: { Role: 'Owner', Active: 1 }, Overdue: 1, Noise: [ 'Done', 'NullStatus' ] },
		{ ID: 2, Status: 'Active', Start: '2026-03-15 10:30:00', Client: 9, Owner: 6, Lead: { Role: 'Lead', Active: 1 }, Overdue: 4, BlankStatus: true, Noise: [ 'Deleted' ] },
		{ ID: 3, Status: 'AtRisk', Start: '2026-05-20 08:00:00', Client: 3, Owner: LEAD, Lead: null, Overdue: 12, Noise: [ 'Future' ] },
		{ ID: 4, Status: 'Active', Start: '2026-07-01 00:00:00', Client: 9, Owner: LEAD, Lead: { Role: 'Lead', Active: 1 }, Overdue: 2 },
		{ ID: 5, Status: 'AtRisk', Start: '2026-11-30 17:45:00', Client: 9, Owner: 7, Lead: { Role: 'Owner', Active: 1 }, Overdue: 3, Noise: [ 'NullDue' ] },
		{ ID: 6, Status: 'Active', Start: '2026-04-04 12:00:00', Client: 3, Owner: 8, Lead: { Role: 'Lead', Active: 1 }, Overdue: 2 },
		{ ID: 7, Status: 'Active', Start: '2026-06-06 06:06:06', Client: 3, Owner: 9, Lead: { Role: 'Lead', Active: 0 }, Overdue: 2 },
		{ ID: 8, Status: 'Active', Start: '2026-08-08 08:08:08', Client: 9, Owner: 10, Lead: { Role: 'Lead', Active: 1, Deleted: true }, Overdue: 2 },
		{ ID: 9, Status: 'Active', Start: '2026-09-09 09:09:09', Client: 3, Owner: LEAD, Lead: null, Overdue: 0, Noise: [ 'Done', 'Deleted', 'Future', 'NullDue' ] },
		{ ID: 10, Status: 'OnHold', Start: '2026-02-02 02:02:02', Client: 3, Owner: 11, Lead: { Role: 'Owner', Active: 1 }, Overdue: 5 },
		{ ID: 11, Status: 'Active', Start: '2025-12-31 23:59:59', Client: 9, Owner: 12, Lead: { Role: 'Lead', Active: 1 }, Overdue: 1 },
		{ ID: 12, Status: 'Active', Start: '2026-03-03 03:03:03', Client: 'Deleted', Owner: LEAD, Lead: null, Overdue: 2 },
		{ ID: 13, Status: 'Active', Start: '2026-10-10 10:10:10', Client: 'CrossTenant', Owner: 13, Lead: { Role: 'Member', Active: 1 }, Overdue: 2 },
		{ ID: 14, Status: 'Done', Start: null, Client: 4, Owner: LEAD, Lead: { Role: 'Owner', Active: 1 }, Overdue: 10 },
		{ ID: 15, Status: '', Start: '2027-03-01 00:00:00', Client: null, Owner: 14, Lead: { Role: 'Lead', Active: 1 }, Overdue: 1 },
		{ ID: 16, Status: 'Active', Start: '2026-12-31 23:59:59', Client: 3, Owner: 15, Lead: { Role: 'Lead', Active: 1 }, Overdue: 1 },
		{ ID: 17, Status: 'Active', Start: '2026-01-20 00:00:00', Client: 3, Owner: LEAD, Deleted: true, Lead: { Role: 'Owner', Active: 1 }, Overdue: 2 },
		{ ID: 18, Status: 'Active', Start: '2026-01-15 00:00:00', Client: 'CrossTenant', Owner: 16, Lead: { Role: 'Owner', Active: 1 }, Overdue: 1 },
		{ ID: 19, Status: 'AtRisk', Start: null, Client: 9, Owner: 17, Lead: { Role: 'Lead', Active: 1 }, Overdue: 1 }
	]);

// Member's (user 2) memberships on story projects: Member / Reviewer roles only.
const MEMBER_STORY = Object.freeze(
	[
		{ Project: 1, Role: 'Member', Active: 1 },
		{ Project: 2, Role: 'Reviewer', Active: 1 },
		{ Project: 3, Role: 'Member', Active: 1 },
		{ Project: 6, Role: 'Member', Active: 0 },
		{ Project: 9, Role: 'Reviewer', Active: 1 },
		{ Project: 13, Role: 'Reviewer', Active: 1, Deleted: true }
	]);

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
	let tmpOtherLead = tmpUsers2[0];
	// Filler users (never a principal; the last user of each tenant is soft-deleted)
	let tmpOthers1 = tmpUsers1.filter((pID) => { return (pID > OUTSIDER) && (pID < tmpUsers1[tmpUsers1.length - 1]); });
	let tmpOthers2 = tmpUsers2.filter((pID) => { return (pID !== tmpOtherLead) && (pID < tmpUsers2[tmpUsers2.length - 1]); });

	let tmpClients1 = libCommon.range(1, fSize('Client', 0));
	let tmpClients2 = libCommon.range(tmpClients1.length + 1, tmpClients1.length + fSize('Client', 1));
	let tmpDeletedClient = tmpClients1[tmpClients1.length - 2];
	let tmpCrossTenantClient = tmpClients2[0];

	let tmpProjects1 = libCommon.range(1, fSize('Project', 0));
	let tmpProjects2 = libCommon.range(tmpProjects1.length + 1, tmpProjects1.length + fSize('Project', 1));
	let tmpFillerProjects1 = tmpProjects1.filter((pID) => { return pID > STORY_PROJECT_COUNT; });

	// ---------------------------------------------------------------- Customer
	let tmpRandom = fStream('Customer');
	tmpRows.Customer.push(libCommon.audit({ IDCustomer: 1, GUIDCustomer: libCommon.guid(tmpRandom), Name: 'Northwind Projects' }, tmpRandom, [ LEAD ], false));
	tmpRows.Customer.push(libCommon.audit({ IDCustomer: 2, GUIDCustomer: libCommon.guid(tmpRandom), Name: 'Southwind Projects' }, tmpRandom, [ tmpOtherLead ], false));

	// ---------------------------------------------------------------- User
	tmpRandom = fStream('User');
	let fUser = (pID, pTenant, pDeleted) =>
	{
		let tmpRow = { IDUser: pID, GUIDUser: libCommon.guid(tmpRandom), LoginID: `user${pID}`, NameFirst: tmpRandom.pick(FIRST_NAMES), NameLast: tmpRandom.pick(LAST_NAMES), IDCustomer: pTenant };
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		return tmpRow;
	};
	tmpUsers1.forEach((pID, pIndex) => { tmpRows.User.push(fUser(pID, 1, pIndex === tmpUsers1.length - 1)); });
	tmpUsers2.forEach((pID, pIndex) => { tmpRows.User.push(fUser(pID, 2, pIndex === tmpUsers2.length - 1)); });
	tmpRows.User[0].NameFirst = 'Lena';
	tmpRows.User[0].NameLast = 'Lead';
	tmpRows.User[1].NameFirst = 'Mo';
	tmpRows.User[1].NameLast = 'Member';
	tmpRows.User[2].NameFirst = 'Otto';
	tmpRows.User[2].NameLast = 'Outsider';

	// ---------------------------------------------------------------- Client
	tmpRandom = fStream('Client');
	tmpClients1.forEach(
		(pID, pIndex) =>
		{
			let tmpName = CLIENT_NAMES[pIndex % CLIENT_NAMES.length] + ((pIndex >= CLIENT_NAMES.length) ? ` ${Math.floor(pIndex / CLIENT_NAMES.length) + 1}` : '');
			tmpRows.Client.push(libCommon.audit({ IDClient: pID, GUIDClient: libCommon.guid(tmpRandom), Name: tmpName, IDCustomer: 1 }, tmpRandom, tmpUsers1, pID === tmpDeletedClient));
		});
	tmpClients2.forEach(
		(pID, pIndex) =>
		{
			tmpRows.Client.push(libCommon.audit({ IDClient: pID, GUIDClient: libCommon.guid(tmpRandom), Name: `Southern ${CLIENT_NAMES[pIndex % CLIENT_NAMES.length]}`, IDCustomer: 2 }, tmpRandom, tmpUsers2, pIndex === tmpClients2.length - 1));
		});

	// ---------------------------------------------------------------- Project
	tmpRandom = fStream('Project');
	let fProject = (pID, pTenant, pFields, pDeleted) =>
	{
		let tmpRow = Object.assign({ IDProject: pID, GUIDProject: libCommon.guid(tmpRandom), Name: `${tmpRandom.pick(PROJECT_WORDS)} ${pID}`, IDCustomer: pTenant }, pFields);
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		return tmpRow;
	};
	let fStoryClient = (pClient) =>
	{
		if (pClient === 'Deleted')
		{
			return tmpDeletedClient;
		}
		if (pClient === 'CrossTenant')
		{
			return tmpCrossTenantClient;
		}
		return pClient;
	};
	LEAD_STORY.forEach(
		(pStory) =>
		{
			tmpRows.Project.push(fProject(pStory.ID, 1, { Status: pStory.Status, StartDate: pStory.Start, IDClient: fStoryClient(pStory.Client), OwnerIDUser: pStory.Owner }, pStory.Deleted === true));
		});
	let fFillerProject = (pID, pTenant) =>
	{
		let tmpClient;
		let tmpRoll = tmpRandom.next();
		if (tmpRoll < 0.05)
		{
			tmpClient = null;
		}
		else if (tmpRoll < 0.07)
		{
			tmpClient = (pTenant === 1) ? tmpCrossTenantClient : tmpRandom.pick(E1_CLIENT_IDS);
		}
		else if (tmpRoll < 0.35)
		{
			tmpClient = (pTenant === 1) ? tmpRandom.pick(E1_CLIENT_IDS) : tmpRandom.pick(tmpClients2);
		}
		else
		{
			tmpClient = tmpRandom.pick((pTenant === 1) ? tmpClients1 : tmpClients2);
		}
		let tmpStart = tmpRandom.chance(0.08) ? null : libCommon.randomDate(tmpRandom, libCommon.epoch(2024, 1, 1), libCommon.epoch(2027, 7, 1));
		let tmpOwner = tmpRandom.chance(0.05) ? null : tmpRandom.pick((pTenant === 1) ? tmpOthers1 : tmpOthers2);
		return fProject(pID, pTenant,
			{
				Status: tmpRandom.weighted((pTenant === 1) ? PROJECT_STATUS_WEIGHTS : PROJECT_STATUS_WEIGHTS_T2),
				StartDate: tmpStart,
				IDClient: tmpClient,
				OwnerIDUser: tmpOwner
			});
	};
	tmpFillerProjects1.forEach((pID) => { tmpRows.Project.push(fFillerProject(pID, 1)); });
	// Tenant 2: OtherLead's story, then filler
	let tmpT2Story = [ tmpProjects2[0], tmpProjects2[1], tmpProjects2[2] ];
	tmpRows.Project.push(fProject(tmpT2Story[0], 2, { Status: 'Active', StartDate: '2026-04-01 00:00:00', IDClient: tmpClients2[1], OwnerIDUser: tmpOtherLead }, false));
	// A tenant-2 project on a tenant-1 client (cross-tenant: existence fails, the key is unlabelled)
	tmpRows.Project.push(fProject(tmpT2Story[1], 2, { Status: 'Active', StartDate: '2026-05-01 00:00:00', IDClient: E1_CLIENT_IDS[0], OwnerIDUser: tmpOtherLead }, false));
	tmpRows.Project.push(fProject(tmpT2Story[2], 2, { Status: 'Active', StartDate: '2026-06-01 00:00:00', IDClient: tmpClients2[1], OwnerIDUser: tmpOtherLead }, true));
	tmpProjects2.slice(3).forEach((pID) => { tmpRows.Project.push(fFillerProject(pID, 2)); });
	let tmpLiveProjects1 = tmpRows.Project.filter((pRow) => { return (pRow.IDCustomer === 1) && (pRow.Deleted === 0); }).map((pRow) => { return pRow.IDProject; });

	// ---------------------------------------------------------------- ProjectMembership
	tmpRandom = fStream('ProjectMembership');
	let tmpMembershipID = 0;
	let tmpMembershipPairs = new Set();
	let fMembership = (pTenant, pProject, pUser, pRole, pActive, pDeleted) =>
	{
		tmpMembershipID++;
		tmpMembershipPairs.add(`${pProject}|${pUser}`);
		let tmpRow = { IDProjectMembership: tmpMembershipID, GUIDProjectMembership: libCommon.guid(tmpRandom), IDProject: pProject, IDUser: pUser, Role: pRole, Active: pActive, IDCustomer: pTenant };
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		tmpRows.ProjectMembership.push(tmpRow);
	};
	LEAD_STORY.forEach(
		(pStory) =>
		{
			if (pStory.Lead)
			{
				fMembership(1, pStory.ID, LEAD, pStory.Lead.Role, pStory.Lead.Active, pStory.Lead.Deleted === true);
			}
		});
	MEMBER_STORY.forEach((pStory) => { fMembership(1, pStory.Project, MEMBER, pStory.Role, pStory.Active, pStory.Deleted === true); });
	// Owners of story projects are Owner-role members too (other users), so ByMember sees them
	LEAD_STORY.forEach(
		(pStory) =>
		{
			if ((pStory.Owner !== LEAD) && (pStory.ID % 2 === 0))
			{
				fMembership(1, pStory.ID, pStory.Owner, 'Owner', 1, false);
			}
		});
	let tmpTarget1 = fSize('ProjectMembership', 0);
	let tmpGuard = 0;
	while ((tmpRows.ProjectMembership.length < tmpTarget1) && (tmpGuard++ < tmpTarget1 * 50))
	{
		let tmpProject = tmpRandom.pick(tmpFillerProjects1);
		let tmpRoll = tmpRandom.next();
		let tmpUser;
		let tmpRole;
		if (tmpRoll < 0.06)
		{
			tmpUser = LEAD;
			tmpRole = tmpRandom.weighted(ROLE_WEIGHTS);
		}
		else if (tmpRoll < 0.14)
		{
			tmpUser = MEMBER;
			tmpRole = tmpRandom.pick([ 'Member', 'Reviewer' ]);
		}
		else
		{
			tmpUser = tmpRandom.pick(tmpOthers1);
			tmpRole = tmpRandom.weighted(ROLE_WEIGHTS);
		}
		if (tmpMembershipPairs.has(`${tmpProject}|${tmpUser}`))
		{
			continue;
		}
		fMembership(1, tmpProject, tmpUser, tmpRole, tmpRandom.chance(0.88) ? 1 : 0);
	}
	// Tenant 2: OtherLead's story, a cross-tenant row (a tenant-2 membership on tenant-1 project 1), filler
	fMembership(2, tmpT2Story[0], tmpOtherLead, 'Owner', 1, false);
	fMembership(2, tmpT2Story[1], tmpOtherLead, 'Lead', 1, false);
	fMembership(2, tmpT2Story[2], tmpOtherLead, 'Owner', 1, false);
	fMembership(2, 1, tmpOtherLead, 'Owner', 1, false);
	let tmpTarget2 = tmpTarget1 + fSize('ProjectMembership', 1);
	tmpGuard = 0;
	while ((tmpRows.ProjectMembership.length < tmpTarget2) && (tmpGuard++ < tmpTarget2 * 50))
	{
		let tmpProject = tmpRandom.pick(tmpProjects2);
		let tmpUser = tmpRandom.chance(0.1) ? tmpOtherLead : tmpRandom.pick(tmpOthers2);
		if (tmpMembershipPairs.has(`${tmpProject}|${tmpUser}`))
		{
			continue;
		}
		fMembership(2, tmpProject, tmpUser, tmpRandom.weighted(ROLE_WEIGHTS), tmpRandom.chance(0.88) ? 1 : 0);
	}

	// ---------------------------------------------------------------- Task
	tmpRandom = fStream('Task');
	let tmpTaskID = 0;
	let fTask = (pTenant, pProject, pUser, pStatus, pDue, pDeleted) =>
	{
		tmpTaskID++;
		let tmpRow = { IDTask: tmpTaskID, GUIDTask: libCommon.guid(tmpRandom), IDProject: pProject, AssignedIDUser: pUser, Status: pStatus, DueDate: pDue, IDCustomer: pTenant };
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		tmpRows.Task.push(tmpRow);
	};
	let fPast = () => { return libCommon.randomDate(tmpRandom, PAST_LO, PAST_HI); };
	let fFuture = () => { return libCommon.randomDate(tmpRandom, FUTURE_LO, FUTURE_HI); };
	LEAD_STORY.forEach(
		(pStory) =>
		{
			for (let i = 0; i < pStory.Overdue; i++)
			{
				let tmpStatus = (pStory.BlankStatus && (i === 0)) ? '' : ((i % 2 === 0) ? 'Open' : 'InProgress');
				// The latest possible past instant once, so a DueDate on the year edge still counts
				let tmpDue = ((pStory.ID === 1) && (i === 0)) ? PAST_EDGE : fPast();
				fTask(1, pStory.ID, LEAD, tmpStatus, tmpDue, false);
			}
			(pStory.Noise || []).forEach(
				(pNoise) =>
				{
					switch (pNoise)
					{
						case 'Done':
							fTask(1, pStory.ID, LEAD, 'Done', fPast(), false);
							break;
						case 'NullStatus':
							fTask(1, pStory.ID, LEAD, null, fPast(), false);
							break;
						case 'Deleted':
							fTask(1, pStory.ID, LEAD, 'Open', fPast(), true);
							break;
						case 'Future':
							fTask(1, pStory.ID, LEAD, 'Open', FUTURE_EDGE, false);
							break;
						case 'NullDue':
							fTask(1, pStory.ID, LEAD, 'Open', null, false);
							break;
					}
				});
		});
	let fFillerDue = () =>
	{
		let tmpRoll = tmpRandom.next();
		return (tmpRoll < 0.55) ? fPast() : ((tmpRoll < 0.85) ? fFuture() : null);
	};
	let tmpTaskTarget1 = fSize('Task', 0);
	while (tmpRows.Task.length < tmpTaskTarget1)
	{
		let tmpRoll = tmpRandom.next();
		let tmpProject = (tmpRoll < 0.02) ? null : ((tmpRoll < 0.03) ? tmpProjects2[0] : tmpRandom.pick(tmpProjects1));
		let tmpUserRoll = tmpRandom.next();
		let tmpUser;
		if ((tmpUserRoll < 0.07) && (tmpProject !== null) && (tmpProject > STORY_PROJECT_COUNT) && (tmpProject <= tmpProjects1.length))
		{
			tmpUser = LEAD;
		}
		else if (tmpUserRoll < 0.17)
		{
			tmpUser = MEMBER;
		}
		else if (tmpUserRoll < 0.22)
		{
			tmpUser = null;
		}
		else
		{
			tmpUser = tmpRandom.pick(tmpOthers1);
		}
		fTask(1, tmpProject, tmpUser, tmpRandom.weighted(TASK_STATUS_WEIGHTS), fFillerDue());
	}
	// Tenant 2: OtherLead's overdue story, a tenant-2 task on tenant-1 project 1 assigned to Lead (invisible), filler
	fTask(2, tmpT2Story[0], tmpOtherLead, 'Open', fPast(), false);
	fTask(2, tmpT2Story[0], tmpOtherLead, 'InProgress', fPast(), false);
	fTask(2, tmpT2Story[1], tmpOtherLead, 'Open', fPast(), false);
	fTask(2, tmpT2Story[2], tmpOtherLead, 'Open', fPast(), false);
	fTask(2, 1, LEAD, 'Open', fPast(), false);
	let tmpTaskTarget2 = tmpTaskTarget1 + fSize('Task', 1);
	while (tmpRows.Task.length < tmpTaskTarget2)
	{
		let tmpUser = tmpRandom.chance(0.12) ? tmpOtherLead : (tmpRandom.chance(0.05) ? null : tmpRandom.pick(tmpOthers2));
		fTask(2, tmpRandom.pick(tmpProjects2), tmpUser, tmpRandom.weighted(TASK_STATUS_WEIGHTS), fFillerDue());
	}

	// ---------------------------------------------------------------- Issue
	tmpRandom = fStream('Issue');
	let tmpIssueID = 0;
	let fIssue = (pTenant, pProject, pSeverity, pState, pDeleted) =>
	{
		tmpIssueID++;
		let tmpRow = { IDIssue: tmpIssueID, GUIDIssue: libCommon.guid(tmpRandom), IDProject: pProject, Severity: pSeverity, State: pState, IDCustomer: pTenant };
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		tmpRows.Issue.push(tmpRow);
	};
	fIssue(1, 6, 'Blocker', 'Open', false);
	fIssue(1, 2, 'Blocker', 'Closed', false);
	fIssue(1, 3, 'Major', 'Open', false);
	fIssue(1, 4, 'Blocker', 'Open', true);
	let tmpIssueTarget1 = fSize('Issue', 0);
	while (tmpRows.Issue.length < tmpIssueTarget1)
	{
		let tmpProject = tmpRandom.chance(0.03) ? null : tmpRandom.pick(tmpFillerProjects1);
		fIssue(1, tmpProject, tmpRandom.weighted(SEVERITY_WEIGHTS), tmpRandom.weighted(ISSUE_STATE_WEIGHTS));
	}
	// Tenant 2: an open Blocker on tenant-1 project 5 (invisible to tenant 1: must not block), filler
	fIssue(2, 5, 'Blocker', 'Open', false);
	fIssue(2, tmpT2Story[0], 'Blocker', 'Open', true);
	let tmpIssueTarget2 = tmpIssueTarget1 + fSize('Issue', 1);
	while (tmpRows.Issue.length < tmpIssueTarget2)
	{
		fIssue(2, tmpRandom.pick(tmpProjects2.slice(1)), tmpRandom.weighted(SEVERITY_WEIGHTS), tmpRandom.weighted(ISSUE_STATE_WEIGHTS));
	}

	// ---------------------------------------------------------------- FormType (global lookup)
	tmpRandom = fStream('FormType');
	for (let i = 1; i <= FORM_TYPE_COUNT; i++)
	{
		tmpRows.FormType.push({ IDFormType: i, GUIDFormType: libCommon.guid(tmpRandom), Name: `Form ${String.fromCharCode(64 + i)}`, Category: (i === FORM_TYPE_COUNT) ? '' : FORM_CATEGORIES[i % FORM_CATEGORIES.length] });
	}

	// ---------------------------------------------------------------- Document
	tmpRandom = fStream('Document');
	let tmpDocumentID = 0;
	let tmpFormWeights = [];
	for (let i = 1; i <= FORM_TYPE_COUNT; i++)
	{
		tmpFormWeights.push([ i, (i === E2_FORM_TYPE_ID) ? 18 : 6 ]);
	}
	tmpFormWeights.push([ null, 3 ]);
	tmpFormWeights.push([ DANGLING_FORM_TYPE_ID, 2 ]);
	let fDocument = (pTenant, pProject, pFields, pDeleted) =>
	{
		tmpDocumentID++;
		let tmpRow = Object.assign(
			{
				IDDocument: tmpDocumentID,
				GUIDDocument: libCommon.guid(tmpRandom),
				Title: `${tmpRandom.pick(PROJECT_WORDS)} report ${tmpDocumentID}`,
				Summary: tmpRandom.chance(0.2) ? null : `Summary of document ${tmpDocumentID}.`,
				DocumentDate: tmpRandom.chance(0.04) ? null : libCommon.randomDate(tmpRandom, libCommon.epoch(2025, 1, 1), libCommon.epoch(2027, 1, 1)),
				Status: tmpRandom.weighted((pTenant === 1) ? DOCUMENT_STATUS_WEIGHTS : DOCUMENT_STATUS_WEIGHTS_T2),
				IDFormType: tmpRandom.weighted(tmpFormWeights),
				IDProject: pProject,
				IDCustomer: pTenant
			}, pFields || {});
		libCommon.audit(tmpRow, tmpRandom, (pTenant === 1) ? tmpUsers1 : tmpUsers2, pDeleted);
		tmpRows.Document.push(tmpRow);
	};
	// Boundary dates of the E2 window, on the E2 form type
	fDocument(1, 1, { DocumentDate: '2026-01-01 00:00:00', IDFormType: E2_FORM_TYPE_ID, Status: 'Final' }, false);
	fDocument(1, 2, { DocumentDate: '2026-06-30 23:59:59', IDFormType: E2_FORM_TYPE_ID, Status: 'Draft' }, false);
	fDocument(1, 3, { DocumentDate: '2026-07-01 00:00:00', IDFormType: E2_FORM_TYPE_ID, Status: 'Final' }, false);
	fDocument(1, 4, { DocumentDate: '2025-12-31 23:59:59', IDFormType: E2_FORM_TYPE_ID, Status: 'Final' }, false);
	// A dangling form type in the window, a soft-deleted E2 document, a document on the soft-deleted
	// project, one on a tenant-2 project (cross-tenant), and one with no project
	fDocument(1, 5, { DocumentDate: '2026-02-14 12:00:00', IDFormType: DANGLING_FORM_TYPE_ID }, false);
	fDocument(1, 6, { DocumentDate: '2026-03-14 12:00:00', IDFormType: E2_FORM_TYPE_ID }, true);
	fDocument(1, DELETED_PROJECT_ID, { DocumentDate: '2026-04-14 12:00:00', IDFormType: E2_FORM_TYPE_ID }, false);
	fDocument(1, tmpProjects2[0], { DocumentDate: '2026-05-14 12:00:00', IDFormType: E2_FORM_TYPE_ID }, false);
	fDocument(1, null, { DocumentDate: '2026-05-15 12:00:00', IDFormType: E2_FORM_TYPE_ID }, false);
	let tmpDocumentTarget1 = fSize('Document', 0);
	while (tmpRows.Document.length < tmpDocumentTarget1)
	{
		let tmpRoll = tmpRandom.next();
		let tmpProject = (tmpRoll < 0.03) ? null : ((tmpRoll < 0.04) ? tmpRandom.pick(tmpProjects2) : tmpRandom.pick(tmpProjects1));
		fDocument(1, tmpProject);
	}
	// Tenant 2: one document on tenant-1 project 1 (cross-tenant), filler
	fDocument(2, 1, { DocumentDate: '2026-03-01 00:00:00', IDFormType: E2_FORM_TYPE_ID, Status: 'Withdrawn' }, false);
	let tmpDocumentTarget2 = tmpDocumentTarget1 + fSize('Document', 1);
	while (tmpRows.Document.length < tmpDocumentTarget2)
	{
		fDocument(2, tmpRandom.chance(0.03) ? null : tmpRandom.pick(tmpProjects2));
	}

	// Every soft-deletable table: at least one deleted row per tenant (Customer excepted: one row per tenant).
	let tmpDeletedFix = fStream('DeletedFix');
	[ 'ProjectMembership', 'Task', 'Issue', 'Document', 'Client', 'Project', 'User' ].forEach(
		(pTable) =>
		{
			[ 1, 2 ].forEach(
				(pTenant) =>
				{
					let tmpTenantRows = tmpRows[pTable].filter((pRow) => { return pRow.IDCustomer === pTenant; });
					if (!tmpTenantRows.some((pRow) => { return pRow.Deleted === 1; }))
					{
						let tmpCandidates = tmpTenantRows.slice(Math.floor(tmpTenantRows.length / 2));
						libCommon.softDelete(tmpDeletedFix.pick(tmpCandidates));
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
					E1ClientIDs: E1_CLIENT_IDS.slice(),
					E2FormTypeID: E2_FORM_TYPE_ID,
					DeletedClientID: tmpDeletedClient,
					CrossTenantClientID: tmpCrossTenantClient,
					DanglingFormTypeID: DANGLING_FORM_TYPE_ID,
					DeletedProjectID: DELETED_PROJECT_ID,
					CrossTenantProjectID: tmpProjects2[0],
					StoryProjectIDs: LEAD_STORY.map((pStory) => { return pStory.ID; }),
					// Lead's story projects E1 must return (the filler may add more; the O-hand SQL is exact)
					E1StoryProjectIDs: [ 1, 2, 3, 4, 5, 16 ],
					BlockedProjectID: 6,
					DeletedBlockerProjectID: 4,
					CrossTenantBlockerProjectID: 5,
					PastEdge: PAST_EDGE,
					FutureEdge: FUTURE_EDGE,
					LiveProjectIDs: tmpLiveProjects1,
					TestNow: TEST_NOW
				},
			Principals:
				{
					Lead: { Tenant: 1, User: LEAD, Note: 'Owner / Lead memberships and ownership on the story projects; overdue tasks in every band.' },
					Member: { Tenant: 1, User: MEMBER, Note: 'Member / Reviewer roles only; owns nothing.' },
					Outsider: { Tenant: 1, User: OUTSIDER, Note: 'Tenant 1; no memberships, owns nothing, no tasks.' },
					OtherLead: { Tenant: 2, User: tmpOtherLead, Note: 'Tenant 2\'s Lead.' }
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
