var R=NewRegistrar("none");var B=NewDnsProvider("bind");
D("example.test", R, DnsProvider(B), TXT("@","v=spf1 -all"), TXT("@","v=spf1 include:x -all"));
