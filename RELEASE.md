# Release process

Application version, Sandbox API version, XP Z12-013 contract version, DGFiP baseline, Schematron version and scenario-catalogue version are separate release dimensions.

Release `1.0.0` is the stable D2F Regulatory Simulation sandbox: PAE/PAR, Directory, Buyer, lifecycle, Flux 10.1/10.3, explicit 10.2/10.4 validation, PPF collection, deterministic scenarios, unified trace and technical evidence reports. Root defaults remain off; the explicit sandbox enables all simulators while external networking remains disabled. Status 212 remains blocked by the shared Payment Contract request.

Production deployment for this repository means the isolated D2F PA Sandbox environment, not D2F Gestion and not a real PA network.
