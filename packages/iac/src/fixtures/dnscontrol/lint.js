// The zones of the lint tests (DNS-10): one that every rule is happy with, and one per rule that breaks only that rule.
// lint.json is this file's `dnscontrol print-ir` (5.5.0): dnscontrol print-ir --config lint.js | jq . > lint.json
var REG = NewRegistrar("none");
var BIND = NewDnsProvider("bind");

D("good.test", REG, DnsProvider(BIND), NO_PURGE,
  A("@", "192.0.2.1"),
  MX("@", 10, "mail.good.test."),
  TXT("@", "v=spf1 -all"),
  TXT("_dmarc", "v=DMARC1; p=reject"),
  CAA("@", "issue", "letsencrypt.org"),
  TXT("_canary", "CANARY-VALUE-7f3a")
);

D("spf.test", REG, DnsProvider(BIND), NO_PURGE,
  MX("@", 10, "mail.spf.test."),
  TXT("@", "v=spf1 -all"),
  TXT("@", "v=spf1 include:CANARY-VALUE-7f3a -all"),
  TXT("_dmarc", "v=DMARC1; p=reject"),
  CAA("@", "issue", "letsencrypt.org")
);

D("dmarc.test", REG, DnsProvider(BIND), NO_PURGE,
  MX("@", 10, "mail.dmarc.test."),
  MX("lists", 10, "mail.dmarc.test."),
  TXT("@", "v=spf1 -all"),
  CAA("@", "issue", "letsencrypt.org")
);

D("caa.test", REG, DnsProvider(BIND), NO_PURGE,
  A("@", "192.0.2.1"),
  TXT("@", "v=spf1 -all")
);

D("ttl.test", REG, DnsProvider(BIND), NO_PURGE,
  A("short", "192.0.2.1", TTL(30)),
  A("edge-low", "192.0.2.2", TTL(60)),
  A("edge-high", "192.0.2.3", TTL(86400)),
  A("long", "192.0.2.4", TTL(172800)),
  CAA("@", "issue", "letsencrypt.org")
);

// no NO_PURGE: a plan of this zone deletes every record the file does not list
D("purge.test", REG, DnsProvider(BIND),
  A("@", "192.0.2.1"),
  CAA("@", "issue", "letsencrypt.org")
);
