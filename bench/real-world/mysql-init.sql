-- Runs once when the MySQL container is first created (see docker-compose.yml).
-- Bun's native SQL client needs mysql_native_password for the bench user.
ALTER USER 'bench'@'%' IDENTIFIED WITH mysql_native_password BY 'bench';
FLUSH PRIVILEGES;
