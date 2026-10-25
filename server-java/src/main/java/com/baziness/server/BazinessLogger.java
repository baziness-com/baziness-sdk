package com.baziness.server;

import java.util.logging.Level;
import java.util.logging.Logger;

/** Where the SDK writes what it does. It never logs secrets or tokens. */
public interface BazinessLogger {
    void info(String message);

    void warn(String message);

    void error(String message);

    /** java.util.logging, logger name {@code baziness}: routed to whatever your server logs with. */
    BazinessLogger JUL = new BazinessLogger() {
        private final Logger logger = Logger.getLogger("baziness");

        @Override
        public void info(String message) {
            logger.log(Level.INFO, message);
        }

        @Override
        public void warn(String message) {
            logger.log(Level.WARNING, message);
        }

        @Override
        public void error(String message) {
            logger.log(Level.SEVERE, message);
        }
    };

    BazinessLogger SILENT = new BazinessLogger() {
        @Override
        public void info(String message) {
        }

        @Override
        public void warn(String message) {
        }

        @Override
        public void error(String message) {
        }
    };
}
