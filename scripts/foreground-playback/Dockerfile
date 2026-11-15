FROM mcr.microsoft.com/playwright@sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9
USER root
RUN cd /tmp && apt-get update && apt-get download ffmpeg=7:6.1.1-3ubuntu5 \
    && sha256sum ffmpeg_*_amd64.deb > /opt/ffmpeg-deb.sha256 \
    && apt-get install -y --no-install-recommends \
    ffmpeg=7:6.1.1-3ubuntu5 fonts-dejavu-core=2.37-8 iproute2 xz-utils \
    && rm -f /tmp/ffmpeg_*_amd64.deb && rm -rf /var/lib/apt/lists/*
COPY node-v24.22.3-linux-x64.tar.xz /tmp/node.tar.xz
RUN echo '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  /tmp/node.tar.xz' | sha256sum -c - \
    && mkdir -p /opt/node24 && tar -xJf /tmp/node.tar.xz -C /opt/node24 --strip-components=1 \
    && rm /tmp/node.tar.xz
ENV PATH=/opt/node24/bin:$PATH
