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

  // One page of every box in the org, numerically ordered by box_number.
  // Returns FLAT rows + a total count ({ items, total }) — not the
  // byPartNumber/byUpc tree — because the Box Lookup default view renders
  // a paginated table like SKU View, not the nested search-result cards.
  // `_shapeRows` stays for actual searches only. Optional status filter
  // mirrors SKU View (all / in_stock / oos / phantom).
  async function listAllPaged(organizationId, opts) {
    return lookupRepo.listAllPaged(organizationId, opts);
  }

  return { search, listAllPaged };
}
