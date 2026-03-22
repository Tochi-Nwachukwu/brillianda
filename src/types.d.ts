
import { Customer } from "@prisma/client";

declare global {
    namespace Express {
        interface Request {
            user?: Customer;
        }
    }
}
