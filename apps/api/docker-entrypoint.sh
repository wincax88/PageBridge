#!/bin/sh
set -eu

npm run prisma:migrate:deploy
exec npm run start
