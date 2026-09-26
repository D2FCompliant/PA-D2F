# Release process

Application version, Sandbox API version, XP Z12-013 contract version, DGFiP baseline, Schematron version and scenario-catalogue version are separate release dimensions.

Release `0.9.0` adds the isolated Phase 3 Lifecycle Simulator to the PAE → Directory Simulator → PAR → Buyer Simulator pipeline in the explicit sandbox environment. Root defaults remain off, PPF simulation remains off, status 212 remains blocked by the shared Payment Contract request, and every adapter remains restricted to `sim://`. This release is not a claim of PA accreditation, AIFE/PPF interoperability, production PPF connectivity or complete XP Z12-013 certification.

Production deployment for this repository means the isolated D2F PA Sandbox environment, not D2F Gestion and not a real PA network.
