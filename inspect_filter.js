const { getMikrotikClient } = require('./mikrotik');
(async () => {
  const { api, client } = await getMikrotikClient();
  const filters = await client.menu('/ip firewall filter').get();
  console.log('--- FILTER RULES ---');
  filters.forEach((f, idx) => {
    console.log(idx, JSON.stringify({
      chain: f.chain,
      action: f.action,
      in: f.inInterface,
      out: f.outInterface,
      dstPort: f.dstPort,
      protocol: f.protocol,
      jumpTarget: f.jumpTarget,
      disabled: f.disabled
    }));
  });
  console.log('--- NAT RULES ---');
  const nats = await client.menu('/ip firewall nat').get();
  nats.forEach((n, idx) => {
    console.log(idx, JSON.stringify({
      chain: n.chain,
      action: n.action,
      in: n.inInterface,
      out: n.outInterface,
      dstPort: n.dstPort,
      protocol: n.protocol,
      toAddresses: n.toAddresses,
      toPorts: n.toPorts,
      disabled: n.disabled
    }));
  });
  api.close();
})();

