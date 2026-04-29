"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuestionType = exports.ExamStatus = exports.UserRole = void 0;
var UserRole;
(function (UserRole) {
    UserRole["SUPER_ADMIN"] = "SUPER_ADMIN";
    UserRole["ADMIN"] = "ADMIN";
    UserRole["TEACHER"] = "TEACHER";
    UserRole["STUDENT"] = "STUDENT";
})(UserRole || (exports.UserRole = UserRole = {}));
var ExamStatus;
(function (ExamStatus) {
    ExamStatus["DRAFT"] = "DRAFT";
    ExamStatus["PUBLISHED"] = "PUBLISHED";
    ExamStatus["CLOSED"] = "CLOSED";
    ExamStatus["ARCHIVED"] = "ARCHIVED";
})(ExamStatus || (exports.ExamStatus = ExamStatus = {}));
var QuestionType;
(function (QuestionType) {
    QuestionType["MULTIPLE_CHOICE"] = "MULTIPLE_CHOICE";
})(QuestionType || (exports.QuestionType = QuestionType = {}));
