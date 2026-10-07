import { createInMemoryGrantRepository } from "../config/authorization";
import { grantRepositoryContract } from "./helpers/grant-repository-contract";

grantRepositoryContract("the in-memory grant repository", (now) =>
  Promise.resolve(createInMemoryGrantRepository({ now }))
);
