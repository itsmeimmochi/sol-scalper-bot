FROM alpine:3.20

RUN apk add --no-cache bash postgresql16-client openssh-client ca-certificates tini

COPY entry.sh /usr/local/bin/observer-entry.sh
RUN chmod +x /usr/local/bin/observer-entry.sh

WORKDIR /observer

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/observer-entry.sh"]
