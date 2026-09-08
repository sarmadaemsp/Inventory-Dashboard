export function createLookupService({ lookupRepo }) {
  // Groups flat box rows into the byPartNumber / byUpc tree the frontend
  // renders. Shared by search() (a single upc/part key) and listAll()
  // (every box in the org, no key) since the shape is identical.
  function _shapeRows(query, rows) {
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

  async function search(organizationId, query) {
    const rows = await lookupRepo.search(organizationId, query);
    return _shapeRows(query, rows);
  }

  // Every box in the org, sorted numerically ascending by box_number
  // (enforced in lookupRepository's ORDER BY). Powers the Box Lookup
  // page's default view before any search term is entered.
  async function listAll(organizationId) {
    const rows = await lookupRepo.listAll(organizationId);
    return _shapeRows('', rows);
  }

  return { search, listAll };
}
