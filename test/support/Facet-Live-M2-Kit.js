/**
 * Facet-Live-M2-Kit — the Live engine's M2 test bench (Builder C): a plain retold-data-service on an
 * in-memory SQLite loaded with the ProjectTrack or LabTrack model (test/fixtures/*-Model.json) and a
 * small, hand-shaped deterministic data set holding every trap the cross-entity folds must survive
 * (two tenants, soft-deleted rows on both sides of every hop, NULL and dangling FKs, cross-tenant
 * references both ways, an owner-scoped LabForm, global lookups), the §31.2 test tenancy / owner
 * behaviors on the ROUTE-BOUND controllers, and the faceting service installed (Embedded).
 *
 * The bench drives the engines IN-PROCESS with hand-built FoldIR (the shapes of internal-contracts
 * §24), so the Live engine is tested independently of the Planner's lowering; the oracle is direct
 * SQL over the same database written from the definitions' prose (tenancy, soft delete and owner
 * scope spelled out per table).
 *
 *   let K = libKit.start({ Domain: 'LabTrack' }, (pError) => …);
 *   K.context('MaterialIntakeRequirement', 'Tech', { Variants, PlanForm, Dialect }) → a request context (principal resolved)
 *   K.execute(K.fable.RetoldFacetingEngineLive, tmpContext, tmpAggs, (pError, pExecution) => …)
 *   K.sql('SELECT …', { … }) → plain rows (SQLite benches only)
 *   K.stop(fDone)
 *
 * Provider: 'SQLite' (default, in memory) or 'PostgreSQL' (through the provider hook of
 * test/support/Facet-Harness-Providers.js: a fresh rfs_* database in the rfs-test-postgres container,
 * the same rows; gated by RFS_TEST_POSTGRES / RFS_TEST_POSTGRES_URL, else start() calls back an error
 * with .Skip === true).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFable = require('fable');
const libRetoldDataService = require('retold-data-service');

const libProviders = require('./Facet-Harness-Providers.js');

const libRetoldFacetingService = require('../../source/Retold-Faceting-Service.js');
const libBookstoreSeed = require('../fixtures/Bookstore-Seed.js');
const libProjectTrackSeed = require('../fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('../fixtures/LabTrack-Seed.js');

const TENANCY_BEHAVIOR_HASHES = [ 'Reads-QueryConfiguration', 'Count-QueryConfiguration' ];

// The pinned clock every test uses (no date compared with $Now sits between 2026 and 2030).
const TEST_NOW = '2026-10-08T12:00:00Z';

const PRINCIPALS = Object.freeze(
	{
		ProjectTrack: Object.freeze(
			{
				Lead: { Tenant: 1, User: 1 },
				Member: { Tenant: 1, User: 2 },
				Outsider: { Tenant: 1, User: 3 },
				OtherLead: { Tenant: 2, User: 101 }
			}),
		LabTrack: Object.freeze(
			{
				Tech: { Tenant: 1, User: 1 },
				Colleague: { Tenant: 1, User: 2 },
				Newbie: { Tenant: 1, User: 3 },
				OtherTech: { Tenant: 2, User: 101 }
			})
	});

/**
 * mulberry32 (the fixtures' only randomness source).
 *
 * @param {number} pSeed
 * @return {() => number}
 */
const prng = (pSeed) =>
{
	return libBookstoreSeed.prng(pSeed);
};

/**
 * A deterministic GUID-shaped string.
 *
 * @param {string} pTable
 * @param {number} pID
 * @return {string}
 */
const guid = (pTable, pID) =>
{
	let tmpHex = Buffer.from(`${pTable}:${pID}`).toString('hex').padEnd(32, '0').slice(0, 32);
	return `${tmpHex.slice(0, 8)}-${tmpHex.slice(8, 12)}-${tmpHex.slice(12, 16)}-${tmpHex.slice(16, 20)}-${tmpHex.slice(20, 32)}`;
};

/**
 * A row with the audit columns filled.
 *
 * @param {string} pTable
 * @param {number} pID
 * @param {Record<string, any>} pValues
 * @param {boolean} pAudited - false for the global lookups
 * @return {Record<string, any>}
 */
const row = (pTable, pID, pValues, pAudited) =>
{
	let tmpRow = {};
	tmpRow[`ID${pTable}`] = pID;
	tmpRow[`GUID${pTable}`] = guid(pTable, pID);
	if (pAudited !== false)
	{
		tmpRow.CreateDate = '2024-06-01 08:00:00';
		tmpRow.CreatingIDUser = 1;
		tmpRow.UpdateDate = '2024-06-01 08:00:00';
		tmpRow.UpdatingIDUser = 1;
		tmpRow.Deleted = 0;
		tmpRow.DeleteDate = null;
		tmpRow.DeletingIDUser = 0;
	}
	return Object.assign(tmpRow, pValues);
};

/**
 * 'YYYY-MM-DD HH:mm:ss' of a UTC epoch-ms.
 *
 * @param {number} pMS
 * @return {string}
 */
const stamp = (pMS) =>
{
	return new Date(pMS).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * LabTrack rows (tenant 1 base, tenant 2 small, every E3 trap).
 *
 * @return {Record<string, Array<Record<string, any>>>}
 */
const labTrackRows = () =>
{
	let tmpRandom = prng(20261008);
	let fPick = (pList) => { return pList[Math.floor(tmpRandom() * pList.length)]; };
	let R = { Customer: [], User: [], LabQueue: [], LabQueueMember: [], MaterialType: [], MaterialIntake: [], LabFormType: [], MaterialIntakeRequirement: [], MaterialTypeFormRequirement: [], LabForm: [] };

	R.Customer.push(row('Customer', 1, { Name: 'Acme Labs' }), row('Customer', 2, { Name: 'Borealis Labs' }));
	for (let i = 1; i <= 12; i++)
	{
		R.User.push(row('User', i, { LoginID: `t1user${i}`, NameFirst: `First${i}`, NameLast: `Last${i}`, IDCustomer: 1 }));
	}
	for (let i = 101; i <= 106; i++)
	{
		R.User.push(row('User', i, { LoginID: `t2user${i}`, NameFirst: `First${i}`, NameLast: `Last${i}`, IDCustomer: 2 }));
	}

	// Global lookup: no audit columns, no Deleted, no IDCustomer.  Discipline '' on one.
	let tmpDisciplines = [ 'Chemistry', 'Biology', 'Physics', 'Chemistry', 'Biology', '', 'Physics', 'Chemistry', 'Biology', 'Geology' ];
	for (let i = 1; i <= 10; i++)
	{
		R.LabFormType.push(row('LabFormType', i, { Name: `Form ${String.fromCharCode(64 + i)}`, Discipline: tmpDisciplines[i - 1] }, false));
	}

	// Queues: 5 is soft-deleted (live intakes inside must drop out); 101–102 are tenant 2.
	[ [ 1, 'Chem Queue' ], [ 2, 'Bio Queue' ], [ 3, 'Phys Queue' ], [ 4, 'Old Queue' ], [ 5, 'Deleted Queue' ], [ 6, 'Colleague Queue' ] ].forEach(
		(pQueue) => { R.LabQueue.push(row('LabQueue', pQueue[0], { Name: pQueue[1], IDCustomer: 1 })); });
	R.LabQueue[4].Deleted = 1;
	R.LabQueue.push(row('LabQueue', 101, { Name: 'Tenant 2 Queue A', IDCustomer: 2 }), row('LabQueue', 102, { Name: 'Tenant 2 Queue B', IDCustomer: 2 }));

	// Members: Tech (1) active in 1, 2; inactive in 3; a soft-deleted membership in 4; active in the
	// deleted queue 5.  Colleague (2) active in 1 and 6.  Newbie (3) in none.  A tenant-2 row says
	// user 1 is active in queue 3 (invisible: must not count).
	let tmpMemberID = 0;
	let fMember = (pQueue, pUser, pActive, pTenant, pDeleted) =>
	{
		tmpMemberID++;
		let tmpRow = row('LabQueueMember', tmpMemberID, { IDLabQueue: pQueue, IDUser: pUser, Active: pActive, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.LabQueueMember.push(tmpRow);
	};
	fMember(1, 1, 1, 1, false);
	fMember(2, 1, 1, 1, false);
	fMember(3, 1, 0, 1, false);
	fMember(4, 1, 1, 1, true);
	fMember(5, 1, 1, 1, false);
	fMember(1, 2, 1, 1, false);
	fMember(6, 2, 1, 1, false);
	fMember(3, 1, 1, 2, false);
	for (let i = 4; i <= 12; i++)
	{
		fMember(1 + (i % 6), i, (i % 3) ? 1 : 0, 1, (i === 7));
	}
	fMember(101, 101, 1, 2, false);
	fMember(102, 102, 1, 2, false);

	for (let i = 1; i <= 5; i++)
	{
		R.MaterialType.push(row('MaterialType', i, { Name: `Type ${i}`, IDCustomer: 1 }));
	}
	R.MaterialType.push(row('MaterialType', 101, { Name: 'Type T2-1', IDCustomer: 2 }), row('MaterialType', 102, { Name: 'Type T2-2', IDCustomer: 2 }));

	// Intakes: tenant 1, ids 1..120; 7 is soft-deleted (with live requirements); NULL queues; ''
	// status; ReceivedDate across ~25 ISO weeks of 2025 (and a few in late 2024) with NULLs.
	let tmpStatuses = [ 'Received', 'InProgress', 'Complete', 'Received', 'InProgress', '' ];
	let tmpQueues = [ 1, 2, 3, 4, 5, 6, 1, 2, null ];
	let tmpBase = Date.UTC(2024, 11, 23, 9, 0, 0);
	for (let i = 1; i <= 120; i++)
	{
		let tmpDate = (i % 11 === 0) ? null : stamp(tmpBase + Math.floor(tmpRandom() * 175) * 86400000 + Math.floor(tmpRandom() * 36000) * 1000);
		let tmpRow = row('MaterialIntake', i,
			{
				ReceivedDate: tmpDate, Status: fPick(tmpStatuses), Priority: fPick([ 'High', 'Normal', 'Low' ]),
				IDLabQueue: fPick(tmpQueues), IDMaterialType: 1 + Math.floor(tmpRandom() * 5), AssignedIDUser: 1 + Math.floor(tmpRandom() * 12), IDCustomer: 1
			});
		R.MaterialIntake.push(tmpRow);
	}
	// Pin a few: intake 7 soft-deleted in Tech's queue 1; intake 8 in the deleted queue 5; 9 in queue 1 Received.
	Object.assign(R.MaterialIntake[6], { Deleted: 1, IDLabQueue: 1, Status: 'Received' });
	Object.assign(R.MaterialIntake[7], { IDLabQueue: 5, Status: 'Received' });
	Object.assign(R.MaterialIntake[8], { IDLabQueue: 1, Status: 'Received', IDMaterialType: 1 });
	// Tenant 2: ids 1001..1025, plus 1026 referencing tenant-1 queue 1 (cross-tenant: invisible queue).
	for (let i = 1001; i <= 1026; i++)
	{
		R.MaterialIntake.push(row('MaterialIntake', i,
			{
				ReceivedDate: stamp(tmpBase + Math.floor(tmpRandom() * 175) * 86400000), Status: fPick([ 'Received', 'InProgress' ]), Priority: 'Normal',
				IDLabQueue: (i === 1026) ? 1 : fPick([ 101, 102 ]), IDMaterialType: fPick([ 101, 102 ]), AssignedIDUser: 101, IDCustomer: 2
			}));
	}

	// Requirements: 1–4 distinct form types per tenant-1 intake (the deleted intake 7 included);
	// some soft-deleted; tenant 2 has its own, plus 9001 on tenant-1 intake 9 (cross-tenant).
	let tmpRequirementID = 0;
	let tmpRequirements = [];
	for (let i = 1; i <= 120; i++)
	{
		let tmpCount = 1 + Math.floor(tmpRandom() * 4);
		let tmpForms = [];
		while (tmpForms.length < tmpCount)
		{
			let tmpForm = 1 + Math.floor(tmpRandom() * 10);
			if (tmpForms.indexOf(tmpForm) < 0)
			{
				tmpForms.push(tmpForm);
			}
		}
		for (let j = 0; j < tmpForms.length; j++)
		{
			tmpRequirementID++;
			let tmpRow = row('MaterialIntakeRequirement', tmpRequirementID, { IDMaterialIntake: i, IDLabFormType: tmpForms[j], IDCustomer: 1 });
			tmpRow.Deleted = (tmpRequirementID % 17 === 0) ? 1 : 0;
			R.MaterialIntakeRequirement.push(tmpRow);
			tmpRequirements.push(tmpRow);
		}
	}
	for (let i = 1001; i <= 1026; i++)
	{
		tmpRequirementID++;
		R.MaterialIntakeRequirement.push(row('MaterialIntakeRequirement', tmpRequirementID, { IDMaterialIntake: i, IDLabFormType: 1 + (i % 10), IDCustomer: 2 }));
	}
	R.MaterialIntakeRequirement.push(row('MaterialIntakeRequirement', 9001, { IDMaterialIntake: 9, IDLabFormType: 3, IDCustomer: 2 }));

	// Type requirements: Required 0 / 1; a DUPLICATE (type 1, form 2) row; a soft-deleted row.
	let tmpTypeRequirementID = 0;
	let fTypeRequirement = (pType, pForm, pRequired, pTenant, pDeleted) =>
	{
		tmpTypeRequirementID++;
		let tmpRow = row('MaterialTypeFormRequirement', tmpTypeRequirementID, { IDMaterialType: pType, IDLabFormType: pForm, Required: pRequired, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.MaterialTypeFormRequirement.push(tmpRow);
	};
	for (let tmpType = 1; tmpType <= 5; tmpType++)
	{
		for (let tmpForm = 1; tmpForm <= 10; tmpForm++)
		{
			if (((tmpType * 7 + tmpForm * 3) % 4) === 0)
			{
				fTypeRequirement(tmpType, tmpForm, ((tmpType + tmpForm) % 5) ? 1 : 0, 1, false);
			}
		}
	}
	fTypeRequirement(1, 2, 1, 1, false);
	fTypeRequirement(1, 2, 1, 1, false);
	fTypeRequirement(2, 9, 1, 1, true);
	fTypeRequirement(101, 4, 1, 2, false);
	fTypeRequirement(102, 5, 1, 2, false);

	// Lab forms: per requirement one of — none; Pending by Tech; Complete by Tech; Complete by
	// Colleague (done only through TenantOnly); Complete but soft-deleted (still to do); Complete in
	// tenant 2 for the tenant-1 intake (invisible: still to do); Pending by Colleague.
	let tmpFormID = 0;
	let fForm = (pIntake, pFormType, pStatus, pOwner, pTenant, pDeleted, pCompleted) =>
	{
		tmpFormID++;
		let tmpRow = row('LabForm', tmpFormID, { IDMaterialIntake: pIntake, IDLabFormType: pFormType, Status: pStatus, CompletedDate: pCompleted || null, OwnerIDUser: pOwner, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.LabForm.push(tmpRow);
	};
	for (let i = 0; i < tmpRequirements.length; i++)
	{
		let tmpRequirement = tmpRequirements[i];
		switch (i % 8)
		{
			case 1:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Pending', 1, 1, false);
				break;
			case 2:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Complete', 1, 1, false, '2025-05-01 10:00:00');
				break;
			case 3:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Complete', 2, 1, false, '2025-05-02 10:00:00');
				break;
			case 4:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Complete', 1, 1, true, '2025-05-03 10:00:00');
				break;
			case 5:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Complete', 101, 2, false, '2025-05-04 10:00:00');
				break;
			case 6:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Pending', 2, 1, false);
				break;
			case 7:
				fForm(tmpRequirement.IDMaterialIntake, tmpRequirement.IDLabFormType, 'Complete', 5, 1, false, '2025-05-05 10:00:00');
				break;
			default:
				break;
		}
	}
	// A form with a NULL form type and one with a NULL intake (they correlate with nothing).
	fForm(9, null, 'Complete', 1, 1, false);
	fForm(null, 3, 'Complete', 1, 1, false);
	return R;
};

/**
 * ProjectTrack rows (tenant 1 base, tenant 2 small, every E1 / E2 trap).
 *
 * @return {Record<string, Array<Record<string, any>>>}
 */
const projectTrackRows = () =>
{
	let tmpRandom = prng(20261009);
	let fPick = (pList) => { return pList[Math.floor(tmpRandom() * pList.length)]; };
	let R = { Customer: [], User: [], Client: [], Project: [], ProjectMembership: [], Task: [], Issue: [], FormType: [], Document: [] };

	R.Customer.push(row('Customer', 1, { Name: 'Acme' }), row('Customer', 2, { Name: 'Borealis' }));
	for (let i = 1; i <= 15; i++)
	{
		R.User.push(row('User', i, { LoginID: `t1user${i}`, NameFirst: `First${i}`, NameLast: `Last${i}`, IDCustomer: 1 }));
	}
	for (let i = 101; i <= 104; i++)
	{
		R.User.push(row('User', i, { LoginID: `t2user${i}`, NameFirst: `First${i}`, NameLast: `Last${i}`, IDCustomer: 2 }));
	}
	// Clients: 8 is soft-deleted (referenced by live projects); 101–103 tenant 2 (101 referenced from tenant 1).
	for (let i = 1; i <= 8; i++)
	{
		R.Client.push(row('Client', i, { Name: `Client ${i}`, IDCustomer: 1 }));
	}
	R.Client[7].Deleted = 1;
	for (let i = 101; i <= 103; i++)
	{
		R.Client.push(row('Client', i, { Name: `T2 Client ${i}`, IDCustomer: 2 }));
	}
	for (let i = 1; i <= 8; i++)
	{
		R.FormType.push(row('FormType', i, { Name: `Form Type ${i}`, Category: fPick([ 'Legal', 'Finance', 'Ops' ]) }, false));
	}

	// Projects 1..60 (tenant 1): statuses incl. ''; StartDate 2024-01..2027-06 with NULLs; clients
	// incl. the deleted 8, NULL and the tenant-2 101; Lead (1) owns a few; some soft-deleted.
	let tmpStatuses = [ 'Active', 'AtRisk', 'OnHold', 'Done', '', 'Active', 'Active', 'AtRisk' ];
	let tmpStartBase = Date.UTC(2024, 0, 1, 0, 0, 0);
	for (let i = 1; i <= 60; i++)
	{
		let tmpStart = (i % 13 === 0) ? null : stamp(tmpStartBase + Math.floor(tmpRandom() * 1270) * 86400000);
		let tmpRow = row('Project', i,
			{
				Name: `Project ${i}`, Status: fPick(tmpStatuses), StartDate: tmpStart,
				IDClient: (i % 17 === 0) ? null : ((i % 19 === 0) ? 101 : 1 + Math.floor(tmpRandom() * 8)),
				OwnerIDUser: (i % 9 === 0) ? 1 : 1 + Math.floor(tmpRandom() * 15), IDCustomer: 1
			});
		tmpRow.Deleted = (i % 23 === 0) ? 1 : 0;
		R.Project.push(tmpRow);
	}
	for (let i = 201; i <= 212; i++)
	{
		R.Project.push(row('Project', i, { Name: `T2 Project ${i}`, Status: fPick(tmpStatuses), StartDate: stamp(tmpStartBase + Math.floor(tmpRandom() * 1270) * 86400000), IDClient: 101, OwnerIDUser: 101, IDCustomer: 2 }));
	}

	// Memberships: Lead (1) Owner/Lead on 1..8 (project 4 inactive, project 5's membership soft-deleted);
	// Member (2) Member/Reviewer on 1..12; others random.
	let tmpMembershipID = 0;
	let fMembership = (pProject, pUser, pRole, pActive, pTenant, pDeleted) =>
	{
		tmpMembershipID++;
		let tmpRow = row('ProjectMembership', tmpMembershipID, { IDProject: pProject, IDUser: pUser, Role: pRole, Active: pActive, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.ProjectMembership.push(tmpRow);
	};
	for (let i = 1; i <= 8; i++)
	{
		fMembership(i, 1, (i % 2) ? 'Owner' : 'Lead', (i === 4) ? 0 : 1, 1, (i === 5));
	}
	for (let i = 1; i <= 12; i++)
	{
		fMembership(i, 2, (i % 2) ? 'Member' : 'Reviewer', 1, 1, false);
	}
	for (let i = 0; i < 120; i++)
	{
		fMembership(1 + Math.floor(tmpRandom() * 60), 4 + Math.floor(tmpRandom() * 12), fPick([ 'Owner', 'Lead', 'Member', 'Reviewer' ]), (tmpRandom() < 0.85) ? 1 : 0, 1, (tmpRandom() < 0.05));
	}
	fMembership(9, 1, 'Lead', 1, 2, false);
	fMembership(201, 101, 'Owner', 1, 2, false);

	// Tasks: DueDate ≤ 2025-12-31, ≥ 2031-01-01 or NULL; Lead's overdue tasks spread so bands
	// 0, 1–2, 3–9 and 10+ are all non-empty.
	let tmpTaskID = 0;
	let fTask = (pProject, pUser, pStatus, pDue, pTenant, pDeleted) =>
	{
		tmpTaskID++;
		let tmpRow = row('Task', tmpTaskID, { IDProject: pProject, AssignedIDUser: pUser, Status: pStatus, DueDate: pDue, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.Task.push(tmpRow);
	};
	let tmpPast = Date.UTC(2024, 2, 1, 0, 0, 0);
	let tmpFuture = Date.UTC(2031, 2, 1, 0, 0, 0);
	let tmpOverdue = [ [ 1, 12 ], [ 2, 4 ], [ 3, 1 ], [ 6, 2 ], [ 7, 9 ], [ 9, 3 ], [ 18, 1 ] ];
	for (let i = 0; i < tmpOverdue.length; i++)
	{
		for (let j = 0; j < tmpOverdue[i][1]; j++)
		{
			fTask(tmpOverdue[i][0], 1, 'Open', stamp(tmpPast + j * 86400000), 1, false);
		}
	}
	// Lead tasks that do NOT count: Done, soft-deleted, future, NULL due.
	fTask(8, 1, 'Done', stamp(tmpPast), 1, false);
	fTask(8, 1, 'Open', stamp(tmpPast), 1, true);
	fTask(8, 1, 'Open', stamp(tmpFuture), 1, false);
	fTask(8, 1, 'Open', null, 1, false);
	for (let i = 0; i < 250; i++)
	{
		let tmpDue = fPick([ stamp(tmpPast + Math.floor(tmpRandom() * 600) * 86400000), stamp(tmpFuture + Math.floor(tmpRandom() * 300) * 86400000), null ]);
		fTask(1 + Math.floor(tmpRandom() * 60), 2 + Math.floor(tmpRandom() * 14), fPick([ 'Open', 'Done', 'InProgress' ]), tmpDue, 1, (tmpRandom() < 0.06));
	}
	fTask(3, 1, 'Open', stamp(tmpPast), 2, false);

	// Issues: open Blockers on some of Lead's projects; a closed Blocker; an open non-Blocker; a
	// SOFT-DELETED open Blocker (must not block); a tenant-2 open Blocker on tenant-1 project 6 (invisible).
	let tmpIssueID = 0;
	let fIssue = (pProject, pSeverity, pState, pTenant, pDeleted) =>
	{
		tmpIssueID++;
		let tmpRow = row('Issue', tmpIssueID, { IDProject: pProject, Severity: pSeverity, State: pState, IDCustomer: pTenant });
		tmpRow.Deleted = pDeleted ? 1 : 0;
		R.Issue.push(tmpRow);
	};
	fIssue(2, 'Blocker', 'Open', 1, false);
	fIssue(3, 'Blocker', 'Closed', 1, false);
	fIssue(3, 'Major', 'Open', 1, false);
	fIssue(1, 'Blocker', 'Open', 1, true);
	fIssue(6, 'Blocker', 'Open', 2, false);
	for (let i = 0; i < 70; i++)
	{
		fIssue(10 + Math.floor(tmpRandom() * 50), fPick([ 'Blocker', 'Major', 'Minor', 'Minor' ]), fPick([ 'Open', 'Closed' ]), 1, (tmpRandom() < 0.05));
	}

	// Documents across 2025-01..2026-12 with NULL dates; form types 1..8, NULL and dangling 99.
	let tmpDocumentBase = Date.UTC(2025, 0, 1, 0, 0, 0);
	for (let i = 1; i <= 200; i++)
	{
		let tmpRow = row('Document', i,
			{
				Title: `Doc ${i}`, Summary: `Summary ${i}`,
				DocumentDate: (i % 15 === 0) ? null : stamp(tmpDocumentBase + Math.floor(tmpRandom() * 729) * 86400000),
				Status: fPick([ 'Draft', 'Final', 'Final', '' ]),
				IDFormType: (i % 21 === 0) ? null : ((i % 31 === 0) ? 99 : 1 + Math.floor(tmpRandom() * 8)),
				IDProject: (i % 25 === 0) ? null : 1 + Math.floor(tmpRandom() * 60), IDCustomer: 1
			});
		tmpRow.Deleted = (i % 27 === 0) ? 1 : 0;
		R.Document.push(tmpRow);
	}
	for (let i = 501; i <= 520; i++)
	{
		R.Document.push(row('Document', i, { Title: `T2 Doc ${i}`, Summary: '', DocumentDate: stamp(tmpDocumentBase + Math.floor(tmpRandom() * 729) * 86400000), Status: 'Final', IDFormType: 1 + (i % 8), IDProject: (i === 520) ? 1 : 201, IDCustomer: 2 }));
	}
	return R;
};

/**
 * Insert every row of a domain (one transaction, model column order, missing → NULL).
 *
 * @param {any} pDB
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 */
const insertRows = (pDB, pModel, pRows) =>
{
	pDB.exec('BEGIN');
	try
	{
		let tmpTables = Object.keys(pRows);
		for (let i = 0; i < tmpTables.length; i++)
		{
			let tmpColumns = pModel.Tables[tmpTables[i]].Columns.map((pColumn) => { return pColumn.Column; });
			let tmpStatement = pDB.prepare(`INSERT INTO "${tmpTables[i]}" (${tmpColumns.map((pColumn) => { return `"${pColumn}"`; }).join(', ')}) VALUES (${tmpColumns.map(() => { return '?'; }).join(', ')})`);
			for (let j = 0; j < pRows[tmpTables[i]].length; j++)
			{
				let tmpRow = pRows[tmpTables[i]][j];
				tmpStatement.run(...tmpColumns.map((pColumn) => { return (Object.prototype.hasOwnProperty.call(tmpRow, pColumn) && (typeof(tmpRow[pColumn]) !== 'undefined')) ? tmpRow[pColumn] : null; }));
			}
		}
		pDB.exec('COMMIT');
	}
	catch (pError)
	{
		pDB.exec('ROLLBACK');
		throw pError;
	}
};

/**
 * The §31.2 test tenancy (and LabForm owner) behavior.
 *
 * @param {boolean} pOwner - also append OwnerIDUser = UserID
 * @return {Function}
 */
const tenancyBehavior = (pOwner) =>
{
	return function (pRequest, pRequestState, fCallback)
	{
		let tmpSession = pRequestState.SessionData || {};
		if (!tmpSession.CustomerID)
		{
			return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
		}
		pRequestState.Query.addFilter('IDCustomer', tmpSession.CustomerID, '=', 'AND', 'TestTenancy');
		if (pOwner)
		{
			if (!tmpSession.UserID)
			{
				return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
			}
			pRequestState.Query.addFilter('OwnerIDUser', tmpSession.UserID, '=', 'AND', 'TestOwner');
		}
		return fCallback();
	};
};

/**
 * Chain-wrap a behavior onto a controller hash (setBehavior is single-slot).
 *
 * @param {any} pController
 * @param {string} pHash
 * @param {Function} fBehavior
 */
const installBehavior = (pController, pHash, fBehavior) =>
{
	let tmpInjection = pController.BehaviorInjection;
	let tmpExisting = (tmpInjection._BehaviorFunctions && Object.prototype.hasOwnProperty.call(tmpInjection._BehaviorFunctions, pHash)) ? tmpInjection._BehaviorFunctions[pHash] : null;
	if (typeof(tmpExisting) !== 'function')
	{
		tmpInjection.setBehavior(pHash, fBehavior);
		return;
	}
	tmpInjection.setBehavior(pHash,
		function (pRequest, pRequestState, fCallback)
		{
			return tmpExisting.call(this, pRequest, pRequestState,
				(pError) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					return fBehavior.call(this, pRequest, pRequestState, fCallback);
				});
		});
};

/**
 * Start a bench.
 *
 * @param {{ Domain: string, Faceting?: Record<string, any>, LogLevel?: string, Mutate?: (pRows: Record<string, any>) => void }} pOptions
 * @param {(pError?: Error) => void} fDone
 * @return {Record<string, any>}
 */
const start = (pOptions, fDone) =>
{
	let tmpOptions = Object.assign({ Domain: 'LabTrack', Provider: 'SQLite', Faceting: {}, LogLevel: 'fatal' }, pOptions);
	let tmpSeed = (tmpOptions.Domain === 'ProjectTrack') ? libProjectTrackSeed : libLabTrackSeed;
	let tmpModel = tmpSeed.model();
	let tmpRows = (tmpOptions.Domain === 'ProjectTrack') ? projectTrackRows() : labTrackRows();
	if (typeof(tmpOptions.Mutate) === 'function')
	{
		tmpOptions.Mutate(tmpRows);
	}
	let tmpFaceting = JSON.parse(JSON.stringify(tmpSeed.FACETING_OPTIONS));
	tmpFaceting.Definitions = { Path: false, Files: [], Objects: [] };
	tmpFaceting = libRetoldFacetingService.Options.deepMerge(tmpFaceting, tmpOptions.Faceting);

	let K = (
		{
			Domain: tmpOptions.Domain,
			Provider: tmpOptions.Provider,
			model: tmpModel,
			rows: tmpRows,
			principals: PRINCIPALS[tmpOptions.Domain],
			fable: null, rds: null, faceting: null, db: null, connection: null,
			TEST_NOW: TEST_NOW
		});

	let tmpAvailable = libProviders.available(tmpOptions.Provider);
	if (!tmpAvailable.Available)
	{
		let tmpSkip = new Error(tmpAvailable.Reason || `${tmpOptions.Provider} is unavailable.`);
		tmpSkip.Skip = true;
		setImmediate(() => { fDone(tmpSkip); });
		K.stop = (fStopDone) => { return fStopDone(); };
		return K;
	}

	let tmpFable = new libFable(Object.assign(
		{
			Product: 'RetoldFacetingLiveM2',
			ProductVersion: '0.0.1',
			APIServerPort: 0,
			LogStreams: [ { streamtype: 'console', level: tmpOptions.LogLevel } ]
		}, libProviders.fableSettings(tmpOptions.Provider, tmpOptions)));
	K.fable = tmpFable;
	// The bench's rows as a seed module for the provider hook (SQLite: build; PostgreSQL: generate).
	let tmpSeedModule = (
		{
			build: (pDB) =>
			{
				libBookstoreSeed.createTables(pDB, tmpModel);
				insertRows(pDB, tmpModel, tmpRows);
				return { Model: tmpModel };
			},
			generate: () =>
			{
				return { Fixture: tmpOptions.Domain, Model: tmpModel, Rows: tmpRows, Order: Object.keys(tmpRows), Tenants: [ 1, 2 ], TenantColumn: 'IDCustomer', Traps: {}, Principals: PRINCIPALS[tmpOptions.Domain] };
			}
		});
	libProviders.connect(tmpOptions.Provider, tmpFable, tmpOptions,
		(pConnectError, pConnection) =>
		{
			if (pConnectError)
			{
				return fDone(pConnectError);
			}
			K.connection = pConnection;
			K.db = pConnection.db;
			libProviders.seed(pConnection, tmpSeedModule, {},
				(pSeedError) =>
				{
					if (pSeedError)
					{
						return fDone(pSeedError);
					}
					tmpFable.serviceManager.addServiceType('RetoldDataService', libRetoldDataService);
					tmpFable.serviceManager.instantiateServiceProvider('RetoldDataService', { StorageProvider: pConnection.StorageProvider, FullMeadowSchemaFilename: false });
					K.rds = tmpFable.RetoldDataService;
					K.rds.initializeService(
						(pInitError) =>
						{
							if (pInitError)
							{
								return fDone(pInitError);
							}
							K.rds.loadModel(tmpOptions.Domain, tmpModel, pConnection.StorageProvider,
								(pLoadError) =>
								{
									if (pLoadError)
									{
										return fDone(pLoadError);
									}
									let tmpEntities = Object.keys(tmpFable.MeadowEndpoints);
									for (let i = 0; i < tmpEntities.length; i++)
									{
										let tmpTable = tmpModel.Tables[tmpEntities[i]];
										if (!tmpTable || !tmpTable.Columns.some((pColumn) => { return pColumn.Column === 'IDCustomer'; }))
										{
											continue;
										}
										let tmpOwner = (tmpEntities[i] === 'LabForm');
										for (let j = 0; j < TENANCY_BEHAVIOR_HASHES.length; j++)
										{
											installBehavior(tmpFable.MeadowEndpoints[tmpEntities[i]].controller, TENANCY_BEHAVIOR_HASHES[j], tenancyBehavior(tmpOwner));
										}
									}
									libRetoldFacetingService.installOnRetoldDataService(K.rds, tmpFaceting,
										(pInstallError, pService) =>
										{
											if (pInstallError)
											{
												return fDone(pInstallError);
											}
											K.faceting = pService || tmpFable.RetoldFacetingService;
											return fDone();
										});
								});
						});
				});
		});

	/**
	 * A synthetic request for a principal ({ Tenant, User } or a principal name; null = anonymous).
	 */
	K.request = (pEntity, pPrincipal) =>
	{
		let tmpPrincipal = (typeof(pPrincipal) === 'string') ? K.principals[pPrincipal] : pPrincipal;
		let tmpRequest = { params: { Entity: pEntity }, headers: {}, query: {}, body: null };
		if (tmpPrincipal)
		{
			tmpRequest.UserSession = { LoggedIn: true, SessionID: `m2-${tmpPrincipal.Tenant}-${tmpPrincipal.User}`, UserID: tmpPrincipal.User, IDUser: tmpPrincipal.User, CustomerID: tmpPrincipal.Tenant, IDCustomer: tmpPrincipal.Tenant };
		}
		return tmpRequest;
	};

	/**
	 * A request context with the principal resolved through the real PrincipalResolver.
	 *
	 * @param {string} pEntity
	 * @param {string|Record<string, any>} pPrincipal
	 * @param {Record<string, any>} [pOverrides] - Variants, PlanForm, Dialect, Options, Cubes, …
	 * @param {(pError?: Error, pContext?: Record<string, any>) => void} fCallback
	 */
	K.context = (pEntity, pPrincipal, pOverrides, fCallback) =>
	{
		let tmpOverrides = pOverrides || {};
		let tmpContext = K.faceting.newContext(pEntity, K.request(pEntity, pPrincipal), { Now: TEST_NOW, PlanForm: tmpOverrides.PlanForm || {} });
		tmpContext.Dialect = K.connection.StorageProvider;
		Object.keys(tmpOverrides).forEach((pKey) => { if (pKey !== 'PlanForm') { tmpContext[pKey] = tmpOverrides[pKey]; } });
		if (tmpOverrides.PlanForm)
		{
			tmpContext.PlanForm = Object.assign({ Cube: 'Auto', Staged: 'Auto' }, tmpOverrides.PlanForm);
		}
		K.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext,
			(pError, pResolved) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				tmpContext.Principal = pResolved;
				return fCallback(null, tmpContext);
			});
	};

	/**
	 * Run an engine and leave its stack before calling back.
	 */
	K.execute = (pEngine, pContext, pAggs, fCallback) =>
	{
		pEngine.execute(pContext, pAggs,
			(pError, pExecution) =>
			{
				setImmediate(() => { fCallback(pError, pExecution); });
			});
	};

	/**
	 * Direct SQL over the fixture database → plain rows.
	 */
	K.sql = (pSQL, pParams) =>
	{
		if (!K.db)
		{
			throw new Error('Facet-Live-M2-Kit: K.sql runs on SQLite benches only.');
		}
		let tmpStatement = K.db.prepare(pSQL);
		return tmpStatement.all(pParams || {}).map((pRow) => { return Object.assign({}, pRow); });
	};

	/**
	 * Close the database (the server never listens: in-process only).
	 */
	K.stop = (fStopDone) =>
	{
		let fClose = () =>
		{
			if (!K.connection)
			{
				return fStopDone();
			}
			let tmpConnection = K.connection;
			K.connection = null;
			return libProviders.release(tmpConnection, () => { return fStopDone(); });
		};
		if (K.fable && K.fable.Orator && (typeof(K.fable.Orator.stopWebServer) === 'function'))
		{
			return K.fable.Orator.stopWebServer(() => { return fClose(); });
		}
		return fClose();
	};

	return K;
};

module.exports = (
	{
		start: start,
		labTrackRows: labTrackRows,
		projectTrackRows: projectTrackRows,
		tenancyBehavior: tenancyBehavior,
		installBehavior: installBehavior,
		PRINCIPALS: PRINCIPALS,
		TEST_NOW: TEST_NOW
	});
