var REG = NewRegistrar("none");
var BIND = NewDnsProvider("bind");
D("example.test", REG, DnsProvider(BIND),
  A("@", "192.0.2.1"),
  A("www", "192.0.2.2"),
  TXT("@", "v=spf1 -all"),
  MX("@", 10, "mail.example.test."),
  TXT("_canary", "CANARY-VALUE-7f3a")
);
