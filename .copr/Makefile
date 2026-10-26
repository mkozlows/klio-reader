# COPR's "make_srpm" build method runs this to turn the repository into a
# source RPM. The source tarball is the release asset that the spec names.
spec := klio-reader.spec

srpm:
	dnf -y install rpmdevtools
	spectool -g -C $(outdir) $(spec)
	rpmbuild -bs --define '_sourcedir $(outdir)' --define '_srcrpmdir $(outdir)' $(spec)
