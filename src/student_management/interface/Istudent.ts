import type { parent } from "./Iparent.js";


export interface Istudent {
    student_id: string;
    name: string;
    email: string;
    password: string;
    school_id: string;
    class_id: string;
    parents: parent[];
    address: string;
    gender: string;
    date_of_birth: string;
    admission_number: string;
    admission_date: string;
    
}

