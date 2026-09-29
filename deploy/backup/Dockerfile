FROM postgres:16.10-alpine
COPY deploy/backup/backup-once deploy/backup/backup-poll deploy/backup/restore-into-empty /usr/local/bin/
RUN chmod 755 /usr/local/bin/backup-once /usr/local/bin/backup-poll /usr/local/bin/restore-into-empty \
    && printf '0 2 * * * /usr/local/bin/backup-once\n* * * * * /usr/local/bin/backup-poll\n' > /etc/crontabs/root
ENV TZ=UTC
CMD ["crond", "-f", "-l", "8"]
