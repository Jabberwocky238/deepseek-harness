FROM alpine:3.22
RUN apk add --no-cache openssh-server \
    && adduser -D playground \
    && echo 'playground:playground-test' | chpasswd \
    && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
