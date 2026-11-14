# The sandbox image of the example app: Node.js 26 for the app, git for checkouts, and the .NET 10
# SDK for the toolchain. Node-based, since the gVisor backend's egress forwarder runs on the image's
# node. Build it and push it to Docker Hub, which is where every sandbox backend pulls from:
#
#   docker build -t <account>/mesh-flow-example:dotnet10 .
#   docker push <account>/mesh-flow-example:dotnet10
#
# then name it in main.mts.
FROM node:26-bookworm

# The SDK needs ICU, which bookworm has as libicu72.
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends libicu72 \
	&& rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location https://dot.net/v1/dotnet-install.sh --output /tmp/dotnet-install.sh \
	&& bash /tmp/dotnet-install.sh --channel 10.0 --install-dir /usr/share/dotnet \
	&& ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
	&& rm /tmp/dotnet-install.sh

# Package signatures are checked without the revocation hosts, which the egress doesn't allow.
ENV DOTNET_ROOT=/usr/share/dotnet \
	DOTNET_CLI_TELEMETRY_OPTOUT=1 \
	DOTNET_NOLOGO=1 \
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
	NUGET_CERT_REVOCATION_MODE=offline
