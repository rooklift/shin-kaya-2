![Screenshot](https://user-images.githubusercontent.com/16438795/166155149-e3d58f4d-e02a-436f-928d-fe9b9c2a6665.png)

Simple go game database app. This is a modification of [Shin Kaya](https://github.com/rooklift/shin-kaya) to use a simple-minded database program written in Golang, rather than SQL. This avoids certain annoyances around SQL and Electron.

## About simpledb

The `simpledb.go` file must be compiled into an executable. It is a simple database written by some combination of Opus and GPT. It is fast enough, with the caveat that the Windows Antimalware Service often interferes with it. It may help to make a Windows Antivirus exclusion for some combination of:

* The simpledb executable.
* The electron executable.
* The folder which contains the SGF files.
