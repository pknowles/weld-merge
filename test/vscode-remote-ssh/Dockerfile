FROM debian:bookworm-slim

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		curl \
		git \
		openssh-server \
		tar \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd -m -s /bin/bash weld \
	&& mkdir -p /run/sshd /home/weld/.ssh \
	&& chmod 700 /home/weld/.ssh \
	&& chown -R weld:weld /home/weld/.ssh

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
