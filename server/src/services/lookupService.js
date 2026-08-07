export function createLookupService({ lookupRepo }) {
  async function search(organizationId, query) {
    const rows = await lookupRepo.search(organizationId, query);
    if (!rows.length) return { query, byPartNumber: [], byUpc: [] };

    const pnMap  = {};
    const upcMap = {};

    for (const row of rows) {
      const pn  = row.part_number || '';
      const upc = row.upc || '';

      if (!pnMap[pn])       pnMap[pn]  = {};
      if (!pnMap[pn][upc])  pnMap[pn][upc] = [];
      pnMap[pn][upc].push(row);

      if (!upcMap[upc])      upcMap[upc]  = {};
      if (!upcMap[upc][pn])  upcMap[upc][pn] = [];
      upcMap[upc][pn].push(row);
    }

    const byPartNumber = Object.entries(pnMap).map(([pn, upcs]) => ({
      part_number: pn,
      upcs: Object.entries(upcs).map(([upc, boxes]) => ({ upc, boxes })),
    }));

    const byUpc = Object.entries(upcMap).map(([upc, pns]) => ({
      upc,
      part_numbers: Object.entries(pns).map(([pn, boxes]) => ({ part_number: pn, boxes })),
    }));

    return { query, byPartNumber, byUpc };
  }

  return { search };
}
