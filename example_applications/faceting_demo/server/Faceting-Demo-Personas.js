/**
 * Faceting-Demo-Personas -- the DEMO principal table (DEMO-SPEC §3).  Pure data.
 *
 * DEMO ONLY.  The browser sends `X-Retold-Facet-Demo-Principal: <Key>`; the demo front server (and nothing
 * else) resolves the Key against this table and forwards the harness's test session headers upstream.  A real
 * host resolves the principal from its own session (retold-data-service / RAFS); never deploy this mechanism.
 *
 * The fixtures' story principals are renumbered after seeding (RENUMBER) so the demo runs exactly as design
 * 08 writes it: tenant 1 -> 7, tenant 2 -> 8, and the four story users -> 42, 43, 44, 81 (unused IDs: the
 * seeds use users 1..36).  Bookstore-Tenant only renumbers its tenant column (IDTenant); its users are not
 * principals.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const HEADER = 'X-Retold-Facet-Demo-Principal';

const DEFAULT_PERSONA = 'user42';

const PERSONAS =
[
	{
		Key: 'user42',
		Label: 'User 42',
		Tenant: 7,
		User: 42,
		Summary: 'The story principal of design 08.',
		Domains:
		{
			ProjectTrack: 'Lena Lead: Owner / Lead on the story projects, overdue tasks in every band',
			LabTrack: 'Tess Tech: active in queues 1 and 2',
			Bookstore: 'Tenant 7: the full catalog'
		}
	},
	{
		Key: 'user43',
		Label: 'User 43',
		Tenant: 7,
		User: 43,
		Summary: 'Another user in the same tenant.',
		Domains:
		{
			ProjectTrack: 'Mo Member: Member / Reviewer roles only, owns nothing',
			LabTrack: 'Cole Colleague: shares queue 1 with user 42, also in queue 6',
			Bookstore: 'Tenant 7: the full catalog'
		}
	},
	{
		Key: 'user44',
		Label: 'User 44',
		Tenant: 7,
		User: 44,
		Summary: 'Same tenant, nothing assigned: the empty states.',
		Domains:
		{
			ProjectTrack: 'Otto Outsider: no memberships, owns nothing, no tasks',
			LabTrack: 'Nia Newbie: in no queue',
			Bookstore: 'Tenant 7: the full catalog'
		}
	},
	{
		Key: 'user81',
		Label: 'User 81',
		Tenant: 8,
		User: 81,
		Summary: 'A user in another tenant: nothing of tenant 7 is visible.',
		Domains:
		{
			ProjectTrack: 'Edsger Turing: tenant 8\'s lead',
			LabTrack: 'Margaret Backus: tenant 8\'s technician',
			Bookstore: 'Tenant 8: a 5% clone of the catalog'
		}
	},
	{
		Key: 'anonymous',
		Label: 'Anonymous',
		Tenant: null,
		User: null,
		Summary: 'No session: every facet route answers 401 FACET_UNAUTHENTICATED.',
		Domains:
		{
			ProjectTrack: 'no session',
			LabTrack: 'no session',
			Bookstore: 'no session'
		}
	}
];

// Applied to the seeded databases right after each domain boots (DEMO-SPEC §2.3).  The Users maps are the
// Small seed's; Faceting-Demo-Domains derives them from the seed's named principals (SEED_PRINCIPALS) at boot,
// because the tenant-2 principal's ID grows with the scale (user 31 at Small, 121 at Medium).
const RENUMBER =
{
	ProjectTrack: { TenantColumn: 'IDCustomer', Tenants: { 1: 7, 2: 8 }, UserColumnPattern: /IDUser$/, Users: { 1: 42, 2: 43, 3: 44, 31: 81 } },
	LabTrack: { TenantColumn: 'IDCustomer', Tenants: { 1: 7, 2: 8 }, UserColumnPattern: /IDUser$/, Users: { 1: 42, 2: 43, 3: 44, 31: 81 } },
	Bookstore: { TenantColumn: 'IDTenant', Tenants: { 1: 7, 2: 8 }, UserColumnPattern: null, Users: {} }
};

// The seed's named principals (harness.principals, internal-contracts §31.4) each persona stands for.
const SEED_PRINCIPALS =
{
	ProjectTrack: { Lead: 'user42', Member: 'user43', Outsider: 'user44', OtherLead: 'user81' },
	LabTrack: { Tech: 'user42', Colleague: 'user43', Newbie: 'user44', OtherTech: 'user81' }
};

/**
 * The persona for a header value; unknown or missing -> null (the proxy then forwards NO session: anonymous).
 *
 * @param {string} pKey
 * @return {Record<string, any>|null}
 */
const personaFor = (pKey) =>
{
	if (typeof(pKey) !== 'string')
	{
		return null;
	}
	for (let i = 0; i < PERSONAS.length; i++)
	{
		if (PERSONAS[i].Key === pKey)
		{
			return PERSONAS[i];
		}
	}
	return null;
};

/**
 * The browser-safe projection served at GET /api/Demo/Principals.
 *
 * @return {Record<string, any>}
 */
const publicList = () =>
{
	return (
		{
			Header: HEADER,
			Default: DEFAULT_PERSONA,
			Warning: 'DEMO ONLY: the principal is chosen by a request header the demo host resolves. Never deploy this.',
			Personas: PERSONAS.map(
				(pPersona) =>
				{
					return { Key: pPersona.Key, Label: pPersona.Label, Tenant: pPersona.Tenant, User: pPersona.User, Summary: pPersona.Summary, Domains: Object.assign({}, pPersona.Domains) };
				})
		});
};

module.exports = (
	{
		HEADER: HEADER,
		DEFAULT_PERSONA: DEFAULT_PERSONA,
		PERSONAS: PERSONAS,
		RENUMBER: RENUMBER,
		SEED_PRINCIPALS: SEED_PRINCIPALS,
		personaFor: personaFor,
		publicList: publicList
	});
