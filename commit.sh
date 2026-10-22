#!/bin/sh
git -c core.hooksPath=/dev/null -c user.name="Jack Williams" -c user.email="jack@inngest.com" commit "$@"
